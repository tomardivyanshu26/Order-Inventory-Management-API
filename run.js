/*
 * Load test for the API. Usage: npm run load
 *
 * Needs the same Postgres + Redis as the tests (see tests/setup-env.js: it points at a
 * database whose name contains "test", because this script wipes and re-seeds tables).
 *
 * Measures three things:
 *   1. GET /products with a warm Redis cache        (cache hit)
 *   2. GET /products with a never-seen query each time (cache miss -> PostgreSQL)
 *   3. 200 concurrent checkouts for 100 units of stock (must never oversell)
 *
 * Results depend on YOUR machine. Run it yourself and quote your own numbers.
 */
require('../tests/setup-env');

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createClient } = require('redis');

const PORT = Number(process.env.LOAD_PORT || 8100);
const BASE = `http://127.0.0.1:${PORT}`;
const PRODUCTS = 5000;
const DURATION = Number(process.env.LOAD_DURATION || 15);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS || 50);
const BUYERS = 200;
const STOCK = 100;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/products?limit=1`);
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Server did not start in time');
}

async function seed() {
  await pool.query(
    'TRUNCATE order_items, orders, cart_items, carts, products, users RESTART IDENTITY CASCADE',
  );
  await pool.query(
    `INSERT INTO products (name, sku, description, category, price, stock)
     SELECT 'Product ' || g, 'LOAD-' || g, 'Load test product',
            'category-' || (g % 20), (g % 500) + 0.99, 1000
     FROM generate_series(1, $1) AS g`,
    [PRODUCTS],
  );
  const keys = await redis.keys('products:*');
  if (keys.length) await redis.del(keys);
}

function summarize(name, result) {
  return {
    name,
    requests_per_sec: result.requests.average,
    p50_ms: result.latency.p50,
    p97_5_ms: result.latency.p97_5,
    p99_ms: result.latency.p99,
    max_ms: result.latency.max,
    total_requests: result.requests.total,
    non_2xx: result.non2xx,
    errors: result.errors,
  };
}

const SEARCHES = ['Product', 'Product 1', 'Product 2', 'Product 3'];
const MISS_REQUESTS = SEARCHES.length * 100 * 50; // every request gets a never-seen cache key

// Cache hit: the identical (fairly expensive) query every time.
async function listingHitTest() {
  const path = '/products?search=Product&limit=100&page=1';
  await fetch(`${BASE}${path}`); // warm the cache
  const result = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [{ method: 'GET', path }],
  });
  return summarize('listing, cache hit', result);
}

// Cache miss: 20,000 distinct (search, limit, page) combinations, each requested once,
// so every request has to go to PostgreSQL and then writes its result into Redis.
async function listingMissTest() {
  let n = 0;
  const result = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    amount: MISS_REQUESTS,
    requests: [
      {
        method: 'GET',
        setupRequest: (request) => {
          const i = n++;
          const search = encodeURIComponent(SEARCHES[i % SEARCHES.length]);
          const limit = 1 + (Math.floor(i / SEARCHES.length) % 100);
          const page = 1 + (Math.floor(i / (SEARCHES.length * 100)) % 50);
          request.path = `/products?search=${search}&limit=${limit}&page=${page}`;
          return request;
        },
      },
    ],
  });
  return summarize('listing, cache miss', result);
}

async function checkoutTest() {
  // Seed users + carts straight into the DB (bcrypt registration of 200 users would be slow)
  // and sign JWTs with the same secret the server uses.
  const product = await pool.query(
    `INSERT INTO products (name, sku, category, price, stock)
     VALUES ('Limited item', 'LIMITED-1', 'limited', 10.00, $1) RETURNING id`,
    [STOCK],
  );
  const productId = product.rows[0].id;

  const tokens = [];
  for (let i = 0; i < BUYERS; i += 1) {
    const user = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id, email, role",
      [`buyer${i}@load.test`],
    );
    const cart = await pool.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [
      user.rows[0].id,
    ]);
    await pool.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)', [
      cart.rows[0].id,
      productId,
    ]);
    tokens.push(
      jwt.sign(
        { sub: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role },
        process.env.JWT_SECRET,
        { expiresIn: '1h' },
      ),
    );
  }

  const latencies = [];
  const started = Date.now();
  const responses = await Promise.all(
    tokens.map(async (token) => {
      const t0 = performance.now();
      const response = await fetch(`${BASE}/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      latencies.push(performance.now() - t0);
      return response.status;
    }),
  );
  const elapsedMs = Date.now() - started;

  const succeeded = responses.filter((s) => s === 201).length;
  const rejected = responses.filter((s) => s === 409).length;
  const other = responses.length - succeeded - rejected;
  const finalStock = (await pool.query('SELECT stock FROM products WHERE id = $1', [productId]))
    .rows[0].stock;
  const sold = (
    await pool.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_items')
  ).rows[0].n;

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

  return {
    name: 'concurrent checkout',
    buyers: BUYERS,
    stock: STOCK,
    orders_created: succeeded,
    rejected_out_of_stock: rejected,
    unexpected_responses: other,
    final_stock: finalStock,
    units_sold: sold,
    oversold: sold > STOCK || finalStock < 0,
    wall_time_ms: elapsedMs,
    p50_ms: Number(pct(0.5).toFixed(1)),
    p99_ms: Number(pct(0.99).toFixed(1)),
  };
}

async function main() {
  await redis.connect();
  const server = spawn('node', ['app.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    await waitForServer();
    await seed();

    console.log(`Seeded ${PRODUCTS} products. ${CONNECTIONS} connections for ${DURATION}s each.\n`);

    const hit = await listingHitTest();
    const miss = await listingMissTest();
    const checkout = await checkoutTest();

    console.table([hit, miss].map(({ name, requests_per_sec, p50_ms, p97_5_ms, p99_ms, non_2xx }) => ({
      name, requests_per_sec, p50_ms, p97_5_ms, p99_ms, non_2xx,
    })));
    console.log('Concurrent checkout:');
    console.table([checkout]);

    if (checkout.oversold || checkout.unexpected_responses > 0) {
      console.error('FAIL: oversold stock or unexpected responses during concurrent checkout');
      process.exitCode = 1;
    }

    const results = { run_at: new Date().toISOString(), node: process.version, hit, miss, checkout };
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Saved load-test/results.json');
  } finally {
    server.kill('SIGTERM');
    await Promise.all([pool.end(), redis.quit()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
