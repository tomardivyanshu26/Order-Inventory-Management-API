const request = require('supertest');
const { app, pool, redis, init } = require('../app');

jest.setTimeout(60000);

let counter = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}${Date.now()}${counter++}@example.com`;
const PASSWORD = 'password123';

async function registerAndLogin(prefix = 'user', role = 'customer') {
  const email = uniqueEmail(prefix);
  const registered = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  expect(registered.status).toBe(201);
  if (role === 'admin') {
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [registered.body.id]);
  }
  const login = await request(app).post('/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { id: registered.body.id, email, token: login.body.token };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createProduct(adminToken, overrides = {}) {
  const sku = `SKU-${Date.now()}-${counter++}`;
  const response = await request(app)
    .post('/products')
    .set(auth(adminToken))
    .send({ name: 'Widget', sku, category: 'tools', price: 10, stock: 10, ...overrides });
  expect(response.status).toBe(201);
  return response.body;
}

async function resetState() {
  await pool.query(
    'TRUNCATE order_items, orders, cart_items, carts, products, users RESTART IDENTITY CASCADE',
  );
  const keys = await redis.keys('products:*');
  if (keys.length) await redis.del(keys);
}

let admin;

beforeAll(async () => {
  await init();
});

beforeEach(async () => {
  await resetState();
  admin = await registerAndLogin('admin', 'admin');
});

afterAll(async () => {
  await Promise.all([pool.end(), redis.quit()]);
});

describe('auth', () => {
  test('registers a user and never returns the password hash', async () => {
    const response = await request(app)
      .post('/auth/register')
      .send({ email: 'new@example.com', password: PASSWORD });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ email: 'new@example.com', role: 'customer' });
    expect(response.body.password_hash).toBeUndefined();
  });

  test('rejects duplicate emails with 409', async () => {
    const body = { email: 'dup@example.com', password: PASSWORD };
    await request(app).post('/auth/register').send(body);
    const response = await request(app).post('/auth/register').send(body);
    expect(response.status).toBe(409);
  });

  test.each([
    [{ email: 'not-an-email', password: PASSWORD }],
    [{ email: 'a@example.com', password: 'short' }],
    [{}],
  ])('rejects invalid registration %j with 400', async (body) => {
    const response = await request(app).post('/auth/register').send(body);
    expect(response.status).toBe(400);
  });

  test('login returns a token, and wrong credentials return 401', async () => {
    const user = await registerAndLogin('login');
    expect(user.token).toEqual(expect.any(String));

    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'wrong-password' });
    expect(wrongPassword.status).toBe(401);

    const unknownUser = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });
    expect(unknownUser.status).toBe(401);
  });

  test('protected routes require a valid bearer token', async () => {
    expect((await request(app).get('/cart')).status).toBe(401);
    expect((await request(app).get('/cart').set(auth('garbage'))).status).toBe(401);
  });

  test('malformed JSON body returns 400', async () => {
    const response = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(response.status).toBe(400);
  });
});

describe('products', () => {
  test('admin can create a product; customers and anonymous users cannot', async () => {
    const customer = await registerAndLogin('customer');
    const payload = { name: 'Hammer', sku: 'HAM-1', category: 'tools', price: 12.5, stock: 3 };

    const created = await request(app).post('/products').set(auth(admin.token)).send(payload);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sku: 'HAM-1', stock: 3 });

    expect((await request(app).post('/products').set(auth(customer.token)).send(payload)).status)
      .toBe(403);
    expect((await request(app).post('/products').send(payload)).status).toBe(401);
  });

  test('rejects duplicate SKUs (409) and invalid input (400)', async () => {
    await createProduct(admin.token, { sku: 'SAME' });
    const duplicate = await request(app)
      .post('/products')
      .set(auth(admin.token))
      .send({ name: 'X', sku: 'SAME', category: 'tools', price: 1, stock: 1 });
    expect(duplicate.status).toBe(409);

    const negativePrice = await request(app)
      .post('/products')
      .set(auth(admin.token))
      .send({ name: 'X', sku: 'NEG', category: 'tools', price: -1, stock: 1 });
    expect(negativePrice.status).toBe(400);

    const fractionalStock = await request(app)
      .post('/products')
      .set(auth(admin.token))
      .send({ name: 'X', sku: 'FRAC', category: 'tools', price: 1, stock: 1.5 });
    expect(fractionalStock.status).toBe(400);
  });

  test('GET /products/:id returns the product, 404 if missing, 400 if id is invalid', async () => {
    const product = await createProduct(admin.token);
    expect((await request(app).get(`/products/${product.id}`)).body.sku).toBe(product.sku);
    expect((await request(app).get('/products/999999')).status).toBe(404);
    expect((await request(app).get('/products/abc')).status).toBe(400);
  });

  test('listing supports pagination, search and category filters', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createProduct(admin.token, { name: `Bolt ${i}`, category: 'hardware' });
    }
    await createProduct(admin.token, { name: 'Paint', category: 'decor' });

    const page = await request(app).get('/products?limit=2&page=2');
    expect(page.status).toBe(200);
    expect(page.body.products).toHaveLength(2);

    const search = await request(app).get('/products?search=bolt');
    expect(search.body.products).toHaveLength(5);

    const category = await request(app).get('/products?category=decor');
    expect(category.body.products.map((p) => p.name)).toEqual(['Paint']);
  });

  test('admin can update a product; unknown id returns 404', async () => {
    const product = await createProduct(admin.token);
    const body = { name: 'Renamed', category: 'tools', price: 99.99, stock: 7 };

    const updated = await request(app)
      .put(`/products/${product.id}`)
      .set(auth(admin.token))
      .send(body);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Renamed', stock: 7 });

    const missing = await request(app).put('/products/999999').set(auth(admin.token)).send(body);
    expect(missing.status).toBe(404);
  });
});

describe('redis cache', () => {
  test('listing is served from cache and invalidated when the catalog changes', async () => {
    await createProduct(admin.token, { name: 'First' });

    const before = await request(app).get('/products');
    expect(before.body.products).toHaveLength(1);

    // A cache entry now exists for the current version.
    const keysBefore = await redis.keys('products:[0-9]*:*');
    expect(keysBefore.length).toBeGreaterThan(0);

    // Change the database behind the cache's back: the cached copy is still returned.
    await pool.query("UPDATE products SET name = 'Changed directly in DB'");
    const stale = await request(app).get('/products');
    expect(stale.body.products[0].name).toBe('First');

    // A catalog write through the API bumps the version, so the next read is fresh.
    await createProduct(admin.token, { name: 'Second' });
    const fresh = await request(app).get('/products');
    expect(fresh.body.products).toHaveLength(2);
    expect(fresh.body.products.map((p) => p.name)).toContain('Changed directly in DB');
  });
});

describe('cart', () => {
  test('adds items, accumulates quantity and reports line totals', async () => {
    const customer = await registerAndLogin('shopper');
    const product = await createProduct(admin.token, { price: 4.25 });

    await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 2 }).expect(201);
    await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 1 }).expect(201);

    const cart = await request(app).get('/cart').set(auth(customer.token));
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0]).toMatchObject({ quantity: 3, line_total: '12.75' });
  });

  test('rejects unknown products (404) and bad quantities (400)', async () => {
    const customer = await registerAndLogin('shopper');
    const missing = await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: 424242, quantity: 1 });
    expect(missing.status).toBe(404);

    const product = await createProduct(admin.token);
    const zero = await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 0 });
    expect(zero.status).toBe(400);
  });

  test('removes an item and keeps carts isolated per user', async () => {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const product = await createProduct(admin.token);

    await request(app).post('/cart/items').set(auth(alice.token))
      .send({ product_id: product.id, quantity: 1 });
    expect((await request(app).get('/cart').set(auth(bob.token))).body.items).toHaveLength(0);

    await request(app).delete(`/cart/items/${product.id}`).set(auth(alice.token)).expect(204);
    expect((await request(app).get('/cart').set(auth(alice.token))).body.items).toHaveLength(0);
  });
});

describe('orders', () => {
  test('checkout fails with 400 on an empty cart', async () => {
    const customer = await registerAndLogin('empty');
    const response = await request(app).post('/orders').set(auth(customer.token));
    expect(response.status).toBe(400);
  });

  test('checkout creates the order, reduces stock and clears the cart', async () => {
    const customer = await registerAndLogin('buyer');
    const product = await createProduct(admin.token, { price: 19.99, stock: 5 });
    await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 3 });

    const order = await request(app).post('/orders').set(auth(customer.token));
    expect(order.status).toBe(201);
    expect(order.body.total).toBe('59.97');
    expect(order.body.items).toHaveLength(1);

    const stock = await pool.query('SELECT stock FROM products WHERE id = $1', [product.id]);
    expect(stock.rows[0].stock).toBe(2);
    expect((await request(app).get('/cart').set(auth(customer.token))).body.items).toHaveLength(0);

    const history = await request(app).get('/orders').set(auth(customer.token));
    expect(history.body.orders).toHaveLength(1);
  });

  test('order line items snapshot the name and price at purchase time', async () => {
    const customer = await registerAndLogin('buyer');
    const product = await createProduct(admin.token, { name: 'Original', price: 10, stock: 5 });
    await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 1 });
    const order = await request(app).post('/orders').set(auth(customer.token));

    await request(app).put(`/products/${product.id}`).set(auth(admin.token))
      .send({ name: 'Renamed later', category: 'tools', price: 999, stock: 4 }).expect(200);

    const item = await pool.query(
      'SELECT product_name, unit_price FROM order_items WHERE order_id = $1',
      [order.body.id],
    );
    expect(item.rows[0]).toMatchObject({ product_name: 'Original', unit_price: '10.00' });
  });

  test('checkout fails with 409 when stock is insufficient and changes nothing', async () => {
    const customer = await registerAndLogin('buyer');
    const product = await createProduct(admin.token, { stock: 1 });
    await request(app).post('/cart/items').set(auth(customer.token))
      .send({ product_id: product.id, quantity: 2 });

    const order = await request(app).post('/orders').set(auth(customer.token));
    expect(order.status).toBe(409);

    const stock = await pool.query('SELECT stock FROM products WHERE id = $1', [product.id]);
    expect(stock.rows[0].stock).toBe(1);
    const orders = await pool.query('SELECT COUNT(*)::int AS n FROM orders');
    expect(orders.rows[0].n).toBe(0);
    // The cart is kept so the customer can adjust it.
    expect((await request(app).get('/cart').set(auth(customer.token))).body.items).toHaveLength(1);
  });
});

describe('concurrent checkout (overselling protection)', () => {
  test('never sells more units than are in stock', async () => {
    const STOCK = 5;
    const BUYERS = 15;
    const product = await createProduct(admin.token, { stock: STOCK });

    const buyers = [];
    for (let i = 0; i < BUYERS; i += 1) {
      buyers.push(await registerAndLogin(`racer${i}`));
    }
    await Promise.all(
      buyers.map((buyer) =>
        request(app).post('/cart/items').set(auth(buyer.token))
          .send({ product_id: product.id, quantity: 1 }).expect(201)),
    );

    const responses = await Promise.all(
      buyers.map((buyer) => request(app).post('/orders').set(auth(buyer.token))),
    );
    const succeeded = responses.filter((r) => r.status === 201).length;
    const rejected = responses.filter((r) => r.status === 409).length;

    expect(succeeded).toBe(STOCK);
    expect(rejected).toBe(BUYERS - STOCK);

    const stock = await pool.query('SELECT stock FROM products WHERE id = $1', [product.id]);
    expect(stock.rows[0].stock).toBe(0);
    const sold = await pool.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM order_items');
    expect(sold.rows[0].n).toBe(STOCK);
  });

  test('multi-product carts checked out concurrently do not deadlock or oversell', async () => {
    const productA = await createProduct(admin.token, { stock: 4 });
    const productB = await createProduct(admin.token, { stock: 4 });

    const buyers = [];
    for (let i = 0; i < 8; i += 1) buyers.push(await registerAndLogin(`multi${i}`));
    await Promise.all(buyers.map(async (buyer, index) => {
      // Add products in different orders to provoke lock-ordering problems.
      const ids = index % 2 === 0 ? [productA.id, productB.id] : [productB.id, productA.id];
      for (const id of ids) {
        await request(app).post('/cart/items').set(auth(buyer.token))
          .send({ product_id: id, quantity: 1 }).expect(201);
      }
    }));

    const responses = await Promise.all(
      buyers.map((buyer) => request(app).post('/orders').set(auth(buyer.token))),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(4);
    expect(responses.filter((r) => r.status === 500)).toHaveLength(0);

    const stock = await pool.query('SELECT stock FROM products ORDER BY id');
    expect(stock.rows.map((r) => r.stock)).toEqual([0, 0]);
  });
});
