/**
 * Storage behind a small interface so the handlers are testable with an
 * in-memory store and the SQL lives in one place. Two implementations: D1Store
 * (production) and InMemoryStore (tests).
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface StoredEntry {
  entryId: string;
  entryHash: string;
  prevEntryHash: string | null;
  authorAddress: string;
  entryJson: string;
  receivedAt: number;
}

export interface Store {
  createLedger(id: string, network: number, now: number): Promise<void>;
  getLedger(id: string): Promise<{ network: number } | null>;
  /** Idempotent on (ledgerId, entryId). Returns true if newly inserted. */
  insertEntry(ledgerId: string, e: StoredEntry): Promise<boolean>;
  setHead(ledgerId: string, headHash: string, now: number): Promise<void>;
  getHead(ledgerId: string): Promise<string | null>;
  entriesSince(ledgerId: string, sinceHash: string | null): Promise<StoredEntry[]>;
  distinctAuthors(): Promise<number>;
  /** Fixed-window per-ip limit. Returns true if the request is allowed. */
  hitRateLimit(ipHash: string, windowStart: number, limit: number): Promise<boolean>;
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async createLedger(id: string, network: number, now: number): Promise<void> {
    await this.db.prepare('INSERT INTO ledgers (id, network, createdAt) VALUES (?, ?, ?)').bind(id, network, now).run();
  }

  async getLedger(id: string): Promise<{ network: number } | null> {
    const row = await this.db.prepare('SELECT network FROM ledgers WHERE id = ?').bind(id).first<{ network: number }>();
    return row ?? null;
  }

  async insertEntry(ledgerId: string, e: StoredEntry): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO entries (ledgerId, entryId, entryHash, prevEntryHash, authorAddress, payload, signature, receivedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ledgerId, entryId) DO NOTHING`,
      )
      .bind(ledgerId, e.entryId, e.entryHash, e.prevEntryHash, e.authorAddress, e.entryJson, sigOf(e.entryJson), e.receivedAt)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async setHead(ledgerId: string, headHash: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO heads (ledgerId, headHash, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(ledgerId) DO UPDATE SET headHash = excluded.headHash, updatedAt = excluded.updatedAt`,
      )
      .bind(ledgerId, headHash, now)
      .run();
  }

  async getHead(ledgerId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT headHash FROM heads WHERE ledgerId = ?').bind(ledgerId).first<{ headHash: string }>();
    return row?.headHash ?? null;
  }

  async entriesSince(ledgerId: string, sinceHash: string | null): Promise<StoredEntry[]> {
    let afterReceivedAt = -1;
    if (sinceHash && sinceHash !== 'genesis') {
      const cursor = await this.db
        .prepare('SELECT receivedAt FROM entries WHERE ledgerId = ? AND entryHash = ? LIMIT 1')
        .bind(ledgerId, sinceHash)
        .first<{ receivedAt: number }>();
      if (cursor) afterReceivedAt = cursor.receivedAt;
    }
    const rows = await this.db
      .prepare(
        `SELECT entryId, entryHash, prevEntryHash, authorAddress, payload AS entryJson, receivedAt
         FROM entries WHERE ledgerId = ? AND receivedAt > ? ORDER BY receivedAt ASC`,
      )
      .bind(ledgerId, afterReceivedAt)
      .all<StoredEntry>();
    return rows.results ?? [];
  }

  async distinctAuthors(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(DISTINCT authorAddress) AS n FROM entries').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async hitRateLimit(ipHash: string, windowStart: number, limit: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limit (ipHash, windowStart, count) VALUES (?, ?, 1)
         ON CONFLICT(ipHash, windowStart) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(ipHash, windowStart)
      .first<{ count: number }>();
    // Occasionally drop expired windows so the table cannot grow without bound.
    if (Math.random() < 0.01) {
      await this.db.prepare('DELETE FROM rate_limit WHERE windowStart < ?').bind(windowStart - 600_000).run();
    }
    return (row?.count ?? 1) <= limit;
  }
}

function sigOf(entryJson: string): string {
  try {
    return (JSON.parse(entryJson) as { purseSignature?: string }).purseSignature ?? '';
  } catch {
    return '';
  }
}

/** In-memory store for tests. */
export class InMemoryStore implements Store {
  ledgers = new Map<string, { network: number }>();
  entries = new Map<string, StoredEntry[]>();
  heads = new Map<string, string>();
  #rl = new Map<string, number>();
  #seq = 0;

  async createLedger(id: string, network: number): Promise<void> {
    this.ledgers.set(id, { network });
    this.entries.set(id, []);
  }
  async getLedger(id: string): Promise<{ network: number } | null> {
    return this.ledgers.get(id) ?? null;
  }
  async insertEntry(ledgerId: string, e: StoredEntry): Promise<boolean> {
    const list = this.entries.get(ledgerId);
    if (!list) return false;
    if (list.some((x) => x.entryId === e.entryId)) return false;
    list.push({ ...e, receivedAt: this.#seq++ });
    return true;
  }
  async setHead(ledgerId: string, headHash: string): Promise<void> {
    this.heads.set(ledgerId, headHash);
  }
  async getHead(ledgerId: string): Promise<string | null> {
    return this.heads.get(ledgerId) ?? null;
  }
  async entriesSince(ledgerId: string, sinceHash: string | null): Promise<StoredEntry[]> {
    const list = this.entries.get(ledgerId) ?? [];
    if (!sinceHash || sinceHash === 'genesis') return [...list];
    const idx = list.findIndex((e) => e.entryHash === sinceHash);
    return idx < 0 ? [...list] : list.slice(idx + 1);
  }
  async distinctAuthors(): Promise<number> {
    const s = new Set<string>();
    for (const list of this.entries.values()) for (const e of list) s.add(e.authorAddress);
    return s.size;
  }
  async hitRateLimit(ipHash: string, windowStart: number, limit: number): Promise<boolean> {
    const key = `${ipHash}:${windowStart}`;
    const n = (this.#rl.get(key) ?? 0) + 1;
    this.#rl.set(key, n);
    return n <= limit;
  }
}
