import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './helpers.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await db.drop();
});

describe('migrations', () => {
  it('apply on an empty database, record themselves, and are a no-op the second time', async () => {
    expect(await runMigrations(db.pool)).toEqual(['0001_initial.sql']);
    const { rows } = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['0001_initial.sql']);
    const tables = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'client_events',
      'entries',
      'payment_intents',
      'payment_observations',
      'schema_migrations',
      'tabs',
    ]);
    expect(await runMigrations(db.pool)).toEqual([]);
  });

  it('serialise concurrent runners', async () => {
    const results = await Promise.all([runMigrations(db.pool), runMigrations(db.pool)]);
    expect(results).toEqual([[], []]);
  });
});
