import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  // An idle client losing its connection emits here; without a listener the
  // process would crash on a database restart.
  pool.on('error', onError);
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    // A client that could not roll back is in an unknown state: destroy it.
    client.release(broken);
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof pg.DatabaseError) || err.code !== '23505') return false;
  return constraint === undefined || err.constraint === constraint;
}
