import { ConfigError } from '../config.js';
import { createPool } from '../db.js';
import { runMigrations } from '../migrations.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new ConfigError('DATABASE_URL is required');
  const pool = createPool(url, (err) => process.stderr.write(`idle database client error: ${err.message}\n`));
  try {
    const applied = await runMigrations(pool, undefined, (msg) => process.stdout.write(`${msg}\n`));
    process.stdout.write(applied.length === 0 ? 'schema is up to date\n' : `applied ${applied.length} migration(s)\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
