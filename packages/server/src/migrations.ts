import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.js';

/** Resolves to packages/server/migrations from both src/ and the bundled dist/. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

// Arbitrary constant shared by every migrator so concurrent runs serialise.
const MIGRATION_LOCK_KEY = 7_324_001;

export async function runMigrations(
  pool: Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // Destroying the session is what releases a session-level advisory lock.
      broken = true;
    }
    client.release(broken);
  }
  return applied;
}
