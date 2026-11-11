/**
 * One-shot re-verification of non-terminal payment intents. Read-only towards
 * the chain: it looks transactions up, records what it saw, and never builds,
 * signs or sends anything.
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import type { IntentRow } from '../intents.js';
import { Reconciler } from '../reconciler.js';
import { NimiqRpc } from '../rpc.js';
import { tabId as tabIdSchema, uuid } from '../schemas.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { tab: { type: 'string' }, intent: { type: 'string' } },
    strict: true,
  });
  if (values.tab !== undefined && !tabIdSchema.safeParse(values.tab).success) throw new Error('--tab is not a tab id');
  if (values.intent !== undefined && !uuid.safeParse(values.intent).success) throw new Error('--intent is not a uuid');

  const config = loadConfig();
  const log = pino({ level: 'warn' }, pino.destination(2));
  const pool = createPool(config.databaseUrl, (err) => log.error({ err }, 'idle database client error'));
  const chain = new NimiqRpc({ url: config.nimiqRpcUrl });
  const reconciler = new Reconciler({ pool, chain, log, intervalMs: config.reconcileIntervalMs });
  try {
    const { rows } = await pool.query<IntentRow>(
      `SELECT * FROM payment_intents
       WHERE state NOT IN ('confirmed', 'failed', 'mismatch')
         AND ($1::text IS NULL OR tab_id = $1)
         AND ($2::uuid IS NULL OR id = $2)
       ORDER BY created_at`,
      [values.tab ?? null, values.intent ?? null],
    );
    for (const row of rows) {
      if (row.tx_hash === null) {
        console.log(JSON.stringify({ id: row.id, tabId: row.tab_id, state: row.state, skipped: 'no transaction hash' }));
        continue;
      }
      const after = await reconciler.checkIntent(row.id);
      console.log(
        JSON.stringify({
          id: row.id,
          tabId: row.tab_id,
          txHash: row.tx_hash,
          from: row.state,
          to: after?.state ?? row.state,
          status: after?.last_status ?? null,
          reason: after?.last_reason ?? null,
        }),
      );
    }
    console.log(JSON.stringify({ checked: rows.length }));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`recheck failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
