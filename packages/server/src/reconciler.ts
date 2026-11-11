import { checkClaim } from './chain.js';
import { withTransaction, type Pool } from './db.js';
import { claimOf, getIntent, isTerminal, recordCheck, type IntentRow } from './intents.js';
import type { ChainSource } from './rpc.js';

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ReconcilerOptions {
  pool: Pool;
  chain: ChainSource;
  log: Logger;
  intervalMs: number;
  batchSize?: number;
  /** How long a claimed intent is hidden from other workers while this one checks it. */
  leaseMs?: number;
}

/**
 * Re-verifies submitted payments in the background. Safe to run in several
 * processes: due intents are claimed with FOR UPDATE SKIP LOCKED and leased
 * forward, so no two workers check the same intent in the same round.
 */
export class Reconciler {
  private readonly batchSize: number;
  readonly leaseMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private stopping = false;

  constructor(private readonly opts: ReconcilerOptions) {
    this.batchSize = opts.batchSize ?? 20;
    this.leaseMs = opts.leaseMs ?? 120_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((err: unknown) => this.opts.log.error({ err }, 'reconciler tick failed'))
        .finally(() => {
          this.running = null;
          this.schedule(this.opts.intervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** Checks one batch of due intents. Returns how many were checked. */
  async tick(): Promise<number> {
    const due = await this.claimDue();
    for (const row of due) {
      // Unchecked claims simply wait out their lease.
      if (this.stopping) break;
      await this.check(row);
    }
    return due.length;
  }

  /** Checks a single intent now, whatever its schedule. Terminal intents are left alone. */
  async checkIntent(id: string): Promise<IntentRow | null> {
    const row = await getIntent(this.opts.pool, id);
    if (!row || row.tx_hash === null || isTerminal(row.state)) return row;
    return this.check(row);
  }

  logTerminalIgnored(row: IntentRow): void {
    this.opts.log.warn({ intentId: row.id, state: row.state }, 'intent is terminal; observation recorded, state left unchanged');
  }

  private async check(row: IntentRow): Promise<IntentRow | null> {
    const result = await checkClaim(this.opts.chain, claimOf(row), row.genesis_hash);
    if (result.status === 'unknown') {
      this.opts.log.warn({ intentId: row.id, reason: result.reason }, 'payment check could not reach the chain');
    }
    const updated = await recordCheck(this.opts.pool, row.id, result, this.opts.chain.url, this.opts.intervalMs, (r) =>
      this.logTerminalIgnored(r),
    );
    if (updated && updated.state !== row.state) {
      this.opts.log.info({ intentId: row.id, from: row.state, to: updated.state }, 'payment intent state changed');
    }
    return updated;
  }

  private claimDue(): Promise<IntentRow[]> {
    return withTransaction(this.opts.pool, async (client) => {
      const { rows } = await client.query<IntentRow>(
        `SELECT * FROM payment_intents
         WHERE tx_hash IS NOT NULL
           AND state IN ('submitted', 'observed', 'unknown')
           AND (next_check_at IS NULL OR next_check_at <= now())
         ORDER BY last_checked_at ASC NULLS FIRST, created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (rows.length > 0) {
        await client.query(
          `UPDATE payment_intents SET next_check_at = now() + make_interval(secs => $2::double precision / 1000)
           WHERE id = ANY($1::uuid[])`,
          [rows.map((r) => r.id), this.leaseMs],
        );
      }
      return rows;
    });
  }
}
