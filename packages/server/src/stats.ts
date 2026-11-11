import type { Pool } from './db.js';
import { replayTab } from './ledger.js';

export interface Stats {
  tabs: number;
  tabsWithTwoPlusMembers: number;
  distinctMembers: number;
  expenses: number;
  acceptedShares: number;
  paymentsConfirmed: number;
  events: Record<string, number>;
}

async function computeStats(pool: Pool): Promise<Stats> {
  const members = new Set<string>();
  let tabs = 0;
  let tabsWithTwoPlusMembers = 0;
  let expenses = 0;
  let acceptedShares = 0;
  let cursor = '';
  for (;;) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM tabs WHERE id > $1 ORDER BY id LIMIT 200', [cursor]);
    if (rows.length === 0) break;
    for (const { id } of rows) {
      const { state } = await replayTab(pool, id);
      tabs += 1;
      if (state.members.length >= 2) tabsWithTwoPlusMembers += 1;
      for (const m of state.members) members.add(m.address);
      expenses += state.expenses.length;
      acceptedShares += state.obligations.filter((o) => o.expenseId !== null && o.acceptId !== null).length;
    }
    cursor = rows[rows.length - 1]?.id ?? cursor;
  }
  const confirmed = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_intents WHERE state = 'confirmed'",
  );
  const events = await pool.query<{ event: string; n: string }>(
    'SELECT event, count(*) AS n FROM client_events GROUP BY event ORDER BY event',
  );
  return {
    tabs,
    tabsWithTwoPlusMembers,
    distinctMembers: members.size,
    expenses,
    acceptedShares,
    paymentsConfirmed: Number(confirmed.rows[0]?.n ?? 0),
    events: Object.fromEntries(events.rows.map((r) => [r.event, Number(r.n)])),
  };
}

/** Stats replay every tab, so they are computed at most once per TTL and shared by concurrent callers. */
export class StatsCache {
  private value: { stats: Stats; at: number } | null = null;
  private inflight: Promise<Stats> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 60_000,
  ) {}

  get(): Promise<Stats> {
    if (this.value && Date.now() - this.value.at < this.ttlMs) return Promise.resolve(this.value.stats);
    if (!this.inflight) {
      this.inflight = computeStats(this.pool)
        .then((stats) => {
          this.value = { stats, at: Date.now() };
          return stats;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
}
