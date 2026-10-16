require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (error) => console.error('Redis error:', error.message));

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function requireAuth(request, response, next) {
  const header = request.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'A bearer token is required'));
  }

  try {
    request.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new ApiError(401, 'Token is invalid or expired'));
  }
}

function requireAdmin(request, response, next) {
  if (request.user.role !== 'admin') {
    return next(new ApiError(403, 'Admin access is required'));
  }
  next();
}

function readPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ApiError(400, `${fieldName} must be a positive integer`);
  }
  return number;
}

async function clearProductCache() {
  await redis.incr('products:version');
}

app.post('/auth/register', asyncRoute(async (request, response) => {
  const { email, password } = request.body || {};
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new ApiError(400, 'A valid email is required');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role',
      [email.toLowerCase().trim(), passwordHash],
    );
    response.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new ApiError(409, 'Email is already registered');
    throw error;
  }
}));

app.post('/auth/login', asyncRoute(async (request, response) => {
  const { email, password } = request.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new ApiError(400, 'email and password are required');
  }

  const result = await pool.query(
    'SELECT id, email, password_hash, role FROM users WHERE email = $1',
    [email.toLowerCase().trim()],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new ApiError(401, 'Email or password is incorrect');
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  response.json({ token, expires_in: 3600 });
}));

app.get('/products', asyncRoute(async (request, response) => {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 20));
  const search = (request.query.search || '').trim();
  const category = (request.query.category || '').trim();
  const cacheVersion = await redis.get('products:version') || '0';
  const cacheKey = `products:${cacheVersion}:${JSON.stringify({ page, limit, search, category })}`;

  const cached = await redis.get(cacheKey);
  if (cached) return response.json(JSON.parse(cached));

  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  if (search) {
    values.push(search);
    conditions.push(`name ILIKE '%' || $${values.length} || '%'`);
  }
  if (category) {
    values.push(category);
    conditions.push(`category = $${values.length}`);
  }
  values.push(limit);
  const limitPlaceholder = values.length;
  values.push(offset);
  const offsetPlaceholder = values.length;
  const result = await pool.query(
    `SELECT id, name, sku, description, category, price, stock
     FROM products
     WHERE ${conditions.length ? conditions.join(' AND ') : 'TRUE'}
     ORDER BY id
     LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
    values,
  );
  const payload = { page, limit, products: result.rows };
  await redis.setEx(cacheKey, 60, JSON.stringify(payload));
  response.json(payload);
}));

app.get('/products/:id', asyncRoute(async (request, response) => {
  const id = readPositiveInteger(request.params.id, 'id');
  const result = await pool.query(
    `SELECT id, name, sku, description, category, price, stock
     FROM products WHERE id = $1`,
    [id],
  );
  if (result.rowCount === 0) throw new ApiError(404, 'Product not found');
  response.json(result.rows[0]);
}));

app.post('/products', requireAuth, requireAdmin, asyncRoute(async (request, response) => {
  const { name, sku, description = '', category, price, stock = 0 } = request.body || {};
  if (typeof name !== 'string' || !name.trim() || typeof sku !== 'string' || !sku.trim()) {
    throw new ApiError(400, 'name and sku are required');
  }
  if (typeof category !== 'string' || !category.trim()) {
    throw new ApiError(400, 'category is required');
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0 ||
      !Number.isInteger(stock) || stock < 0) {
    throw new ApiError(400, 'price must be non-negative and stock must be a non-negative integer');
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, sku, description, category, price, stock)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, sku, description, category, price, stock`,
      [name.trim(), sku.trim(), description, category.trim(), price, stock],
    );
    await clearProductCache();
    response.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new ApiError(409, 'SKU already exists');
    throw error;
  }
}));

app.put('/products/:id', requireAuth, requireAdmin, asyncRoute(async (request, response) => {
  const id = readPositiveInteger(request.params.id, 'id');
  const { name, description = '', category, price, stock } = request.body || {};
  if (typeof name !== 'string' || !name.trim() || typeof category !== 'string' || !category.trim()) {
    throw new ApiError(400, 'name and category are required');
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0 ||
      !Number.isInteger(stock) || stock < 0) {
    throw new ApiError(400, 'price must be non-negative and stock must be a non-negative integer');
  }

  const result = await pool.query(
    `UPDATE products SET name = $1, description = $2, category = $3,
                         price = $4, stock = $5
     WHERE id = $6
     RETURNING id, name, sku, description, category, price, stock`,
    [name.trim(), description, category.trim(), price, stock, id],
  );
  if (result.rowCount === 0) throw new ApiError(404, 'Product not found');
  await clearProductCache();
  response.json(result.rows[0]);
}));

app.get('/cart', requireAuth, asyncRoute(async (request, response) => {
  const result = await pool.query(
    `SELECT ci.product_id, p.name, p.price, ci.quantity,
            (p.price * ci.quantity)::numeric(12, 2) AS line_total
     FROM carts c
     JOIN cart_items ci ON ci.cart_id = c.id
     JOIN products p ON p.id = ci.product_id
     WHERE c.user_id = $1 ORDER BY p.name`,
    [request.user.sub],
  );
  response.json({ items: result.rows });
}));

app.post('/cart/items', requireAuth, asyncRoute(async (request, response) => {
  const body = request.body || {};
  const productId = readPositiveInteger(body.product_id, 'product_id');
  const quantity = readPositiveInteger(body.quantity, 'quantity');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query('SELECT id, stock FROM products WHERE id = $1', [productId]);
    if (product.rowCount === 0) throw new ApiError(404, 'Product not found');
    const cart = await client.query(
      `INSERT INTO carts (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id`,
      [request.user.sub],
    );
    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
      [cart.rows[0].id, productId, quantity],
    );
    await client.query('COMMIT');
    response.status(201).json({ product_id: productId, quantity_added: quantity });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/cart/items/:productId', requireAuth, asyncRoute(async (request, response) => {
  const productId = readPositiveInteger(request.params.productId, 'productId');
  await pool.query(
    `DELETE FROM cart_items ci USING carts c
     WHERE ci.cart_id = c.id AND c.user_id = $1 AND ci.product_id = $2`,
    [request.user.sub, productId],
  );
  response.status(204).end();
}));

app.post('/orders', requireAuth, asyncRoute(async (request, response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cartResult = await client.query(
      `SELECT c.id AS cart_id, ci.product_id, ci.quantity,
              p.name, p.price, p.stock
       FROM carts c
       JOIN cart_items ci ON ci.cart_id = c.id
       JOIN products p ON p.id = ci.product_id
       WHERE c.user_id = $1 ORDER BY ci.product_id
       FOR UPDATE OF p`,
      [request.user.sub],
    );
    if (cartResult.rowCount === 0) throw new ApiError(400, 'Cart is empty');

    let totalCents = 0;
    for (const item of cartResult.rows) {
      if (item.stock < item.quantity) {
        throw new ApiError(409, `Not enough stock for ${item.name}`);
      }
      totalCents += Math.round(Number(item.price) * 100) * item.quantity;
    }

    const orderResult = await client.query(
      'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id, total, created_at',
      [request.user.sub, (totalCents / 100).toFixed(2)],
    );
    const order = orderResult.rows[0];

    for (const item of cartResult.rows) {
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [item.quantity, item.product_id],
      );
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.product_id, item.name, item.quantity, item.price],
      );
    }
    await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartResult.rows[0].cart_id]);
    await client.query('COMMIT');
    response.status(201).json({
      id: order.id,
      total: order.total,
      created_at: order.created_at,
      items: cartResult.rows.map((item) => ({
        product_id: item.product_id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.price,
      })),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/orders', requireAuth, asyncRoute(async (request, response) => {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 20));
  const result = await pool.query(
    `SELECT id, total, status, created_at FROM orders
     WHERE user_id = $1 ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [request.user.sub, limit, (page - 1) * limit],
  );
  response.json({ page, limit, orders: result.rows });
}));

app.use((request, response, next) => next(new ApiError(404, 'Route not found')));
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ error: 'Request body must contain valid JSON' });
  }
  if (error instanceof ApiError) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});

async function init() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
  }
  await redis.connect();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

async function start() {
  await init();
  const server = app.listen(process.env.PORT || 8000, '0.0.0.0', () => {
    console.log(`API listening on port ${process.env.PORT || 8000}`);
  });

  async function shutdown() {
    server.close();
    await Promise.all([pool.end(), redis.quit()]);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only start the HTTP server when run directly (`node app.js`), so tests can import the app.
if (require.main === module) {
  start().catch((error) => {
    console.error('Could not start API:', error.message);
    process.exit(1);
  });
}

module.exports = { app, pool, redis, init };
