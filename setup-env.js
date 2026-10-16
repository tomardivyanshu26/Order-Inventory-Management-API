// Runs before every test file. Points the app at a dedicated TEST database and Redis,
// so the tests (which TRUNCATE tables) can never touch real data.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://ecommerce:ecommerce_local@localhost:5432/ecommerce_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-characters-long';

const databaseName = new URL(process.env.DATABASE_URL).pathname.replace('/', '');
if (!databaseName.includes('test')) {
  throw new Error(
    `Refusing to run tests against database "${databaseName}". ` +
      'Use a database whose name contains "test" (set TEST_DATABASE_URL).',
  );
}
