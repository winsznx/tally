import { verifyBindingAttestation } from '@tally/core/binding';
import {
  LogError,
  entryHash,
  entryId,
  replayState,
  validateEntry,
  type EntryType,
  type LedgerState,
  type LogEntry,
} from '@tally/core/log';
import { z } from 'zod';
import { withTransaction, type Pool, type Queryable } from './db.js';

export interface TabRow {
  id: string;
  network: 5 | 24;
  created_at: Date;
}

export async function getTab(q: Queryable, tabId: string): Promise<TabRow | null> {
  const { rows } = await q.query<TabRow>('SELECT id, network, created_at FROM tabs WHERE id = $1', [tabId]);
  return rows[0] ?? null;
}

const REGISTRY_TYPES: readonly EntryType[] = ['LEDGER_OPEN', 'MEMBER_JOIN', 'MEMBER_LEAVE'];

/** Stored rows were validated on insert; parsing them back needs no re-check here because replay re-validates. */
function storedEntry(json: string): LogEntry {
  return JSON.parse(json) as LogEntry;
}

export async function loadEntries(q: Queryable, tabId: string): Promise<LogEntry[]> {
  const { rows } = await q.query<{ entry_json: string }>(
    'SELECT entry_json FROM entries WHERE tab_id = $1 ORDER BY seq',
    [tabId],
  );
  return rows.map((r) => storedEntry(r.entry_json));
}

export async function replayTab(q: Queryable, tabId: string): Promise<{ state: LedgerState; entryCount: number }> {
  const entries = await loadEntries(q, tabId);
  return { state: replayState(entries), entryCount: entries.length };
}

// --- append -----------------------------------------------------------------

const wireEntry = z.strictObject({
  prevEntryHash: z.string().nullable(),
  entryType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  authorAddress: z.string(),
  pursePublicKey: z.string(),
  purseSignature: z.string(),
  nonce: z.string(),
  logicalClock: z.number(),
});

export interface Rejection {
  index: number;
  code: string;
  message: string;
}

export interface AppendResult {
  accepted: number;
  duplicates: number;
  rejected: Rejection[];
}

interface Candidate {
  index: number;
  entry: LogEntry;
  id: string;
  hash: string;
}

/** Structure and signature only; needs no database, so it runs before any lock is taken. */
function prevalidate(raw: unknown, index: number): Candidate | Rejection {
  const shape = wireEntry.safeParse(raw);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return { index, code: 'invalid_entry', message: `${where}${issue?.message ?? 'malformed entry'}` };
  }
  // entryType is narrowed by validateEntry, which rejects anything outside EntryType.
  const entry: LogEntry = { ...shape.data, entryType: shape.data.entryType as EntryType };
  try {
    validateEntry(entry);
    return { index, entry, id: entryId(entry), hash: entryHash(entry) };
  } catch (err) {
    if (!(err instanceof LogError)) throw err;
    const code = err.message.includes('signature does not verify') ? 'bad_signature' : 'invalid_entry';
    return { index, code, message: err.message };
  }
}

const before = (a: { clock: number; id: string }, b: { clock: number; id: string }): boolean =>
  a.clock < b.clock || (a.clock === b.clock && a.id < b.id);

/**
 * Who is a member at a given point of the canonical order. Membership depends
 * only on LEDGER_OPEN, MEMBER_JOIN and MEMBER_LEAVE, so replaying just those
 * entries up to a position gives exactly the membership a full replay sees
 * there. Replays are cached by prefix length until the registry changes.
 */
class MembershipRegistry {
  private readonly items: { entry: LogEntry; id: string; clock: number }[];
  private readonly cache = new Map<number, LedgerState>();

  constructor(entries: LogEntry[]) {
    this.items = entries.map((entry) => ({ entry, id: entryId(entry), clock: entry.logicalClock }));
    this.items.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  stateBefore(c: Candidate): LedgerState {
    const pos = { clock: c.entry.logicalClock, id: c.id };
    let k = 0;
    while (k < this.items.length && before(this.items[k] as { clock: number; id: string }, pos)) k++;
    let state = this.cache.get(k);
    if (!state) {
      state = replayState(this.items.slice(0, k).map((i) => i.entry));
      this.cache.set(k, state);
    }
    return state;
  }

  add(c: Candidate): void {
    this.items.push({ entry: c.entry, id: c.id, clock: c.entry.logicalClock });
    this.items.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    this.cache.clear();
  }
}

function bindingVerifies(e: LogEntry): boolean {
  return verifyBindingAttestation({
    accountAddress: e.authorAddress,
    accountPublicKey: e.payload['accountPublicKey'] as string,
    pursePublicKey: e.pursePublicKey,
    bindingSignature: e.payload['bindingSignature'] as string,
  });
}

/** Rejects exactly the entries replay would skip because the author is not, or cannot become, a member. */
function membershipRejection(c: Candidate, registry: MembershipRegistry, tabIsEmpty: boolean): Omit<Rejection, 'index'> | null {
  const e = c.entry;
  if (e.entryType === 'LEDGER_OPEN') {
    if (!tabIsEmpty) return { code: 'ledger_already_open', message: 'this tab already has entries' };
    if (!bindingVerifies(e)) return { code: 'invalid_binding', message: 'binding attestation does not verify' };
    return null;
  }
  const state = registry.stateBefore(c);
  const member = state.members.find((m) => m.address === e.authorAddress);
  if (e.entryType === 'MEMBER_JOIN') {
    if (state.genesisHash === null) return { code: 'not_member', message: 'no ledger is open before this entry' };
    if (member?.active && member.pursePublicKey !== e.pursePublicKey) {
      return { code: 'not_member', message: 'author is a member with a different session key' };
    }
    if (!member?.active && !bindingVerifies(e)) {
      return { code: 'invalid_binding', message: 'binding attestation does not verify' };
    }
    return null;
  }
  if (!member) return { code: 'not_member', message: 'author is not a member at this point of the log' };
  if (!member.active) return { code: 'not_member', message: 'author has left the tab' };
  if (member.pursePublicKey !== e.pursePublicKey) {
    return { code: 'not_member', message: 'session key does not match the one registered at join' };
  }
  return null;
}

/**
 * Appends a batch of signed entries. The tab row is locked for the duration so
 * concurrent appends to one tab serialise. Returns null when the tab does not exist.
 */
export async function appendEntries(pool: Pool, tabId: string, raw: unknown[]): Promise<AppendResult | null> {
  const rejected: Rejection[] = [];
  const candidates: Candidate[] = [];
  raw.forEach((r, index) => {
    const result = prevalidate(r, index);
    if ('entry' in result) candidates.push(result);
    else rejected.push(result);
  });

  return withTransaction(pool, async (client) => {
    const tab = await client.query('SELECT id FROM tabs WHERE id = $1 FOR UPDATE', [tabId]);
    if (tab.rowCount === 0) return null;

    const known = new Map<string, string>();
    if (candidates.length > 0) {
      const existing = await client.query<{ entry_id: string; entry_hash: string }>(
        'SELECT entry_id, entry_hash FROM entries WHERE tab_id = $1 AND entry_id = ANY($2::text[])',
        [tabId, candidates.map((c) => c.id)],
      );
      for (const row of existing.rows) known.set(row.entry_id, row.entry_hash);
    }
    const registryRows = await client.query<{ entry_json: string }>(
      'SELECT entry_json FROM entries WHERE tab_id = $1 AND entry_type = ANY($2::text[]) ORDER BY seq',
      [tabId, REGISTRY_TYPES],
    );
    const registry = new MembershipRegistry(registryRows.rows.map((r) => storedEntry(r.entry_json)));
    const anyEntry = await client.query('SELECT 1 FROM entries WHERE tab_id = $1 LIMIT 1', [tabId]);
    let tabIsEmpty = anyEntry.rowCount === 0;

    let accepted = 0;
    let duplicates = 0;
    for (const c of candidates) {
      const knownHash = known.get(c.id);
      if (knownHash !== undefined) {
        if (knownHash === c.hash) duplicates += 1;
        else rejected.push({ index: c.index, code: 'conflict', message: 'an entry with this entryId and different content exists' });
        continue;
      }
      const reason = membershipRejection(c, registry, tabIsEmpty);
      if (reason) {
        rejected.push({ index: c.index, ...reason });
        continue;
      }
      await client.query(
        `INSERT INTO entries (tab_id, entry_id, entry_hash, prev_entry_hash, entry_type, author_address, logical_clock, entry_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tabId,
          c.id,
          c.hash,
          c.entry.prevEntryHash,
          c.entry.entryType,
          c.entry.authorAddress,
          c.entry.logicalClock,
          JSON.stringify(c.entry),
        ],
      );
      known.set(c.id, c.hash);
      if (REGISTRY_TYPES.includes(c.entry.entryType)) registry.add(c);
      tabIsEmpty = false;
      accepted += 1;
    }
    rejected.sort((a, b) => a.index - b.index);
    return { accepted, duplicates, rejected };
  });
}

// --- reads ------------------------------------------------------------------

export interface EntryPage {
  entries: { seq: string; entryId: string; entryHash: string; entryJson: string; receivedAt: string }[];
  nextAfter: string | null;
}

export async function entryPage(q: Queryable, tabId: string, after: string, limit: number): Promise<EntryPage> {
  const { rows } = await q.query<{ seq: string; entry_id: string; entry_hash: string; entry_json: string; received_at: Date }>(
    `SELECT seq, entry_id, entry_hash, entry_json, received_at FROM entries
     WHERE tab_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [tabId, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    entries: page.map((r) => ({
      seq: r.seq,
      entryId: r.entry_id,
      entryHash: r.entry_hash,
      entryJson: r.entry_json,
      receivedAt: r.received_at.toISOString(),
    })),
    nextAfter: rows.length > limit ? (page[page.length - 1]?.seq ?? null) : null,
  };
}

export async function tabCounts(q: Queryable, tabId: string): Promise<{ entryCount: number; headSeq: string | null }> {
  const { rows } = await q.query<{ n: string; head: string | null }>(
    'SELECT count(*) AS n, max(seq) AS head FROM entries WHERE tab_id = $1',
    [tabId],
  );
  return { entryCount: Number(rows[0]?.n ?? 0), headSeq: rows[0]?.head ?? null };
}

export interface TabSummary {
  name: string | null;
  memberCount: number;
  expenseCount: number;
  obligationCounts: Record<'PROPOSED' | 'ACCEPTED' | 'CONTESTED' | 'CANCELLED' | 'IN_ROUND', number>;
  paymentCount: number;
  entryCount: number;
  headSeq: string | null;
  cached: true;
}

export async function tabSummary(q: Queryable, tabId: string): Promise<TabSummary> {
  const [{ state }, counts] = await Promise.all([replayTab(q, tabId), tabCounts(q, tabId)]);
  const obligationCounts = { PROPOSED: 0, ACCEPTED: 0, CONTESTED: 0, CANCELLED: 0, IN_ROUND: 0 };
  for (const ob of state.obligations) obligationCounts[ob.status] += 1;
  return {
    name: state.ledgerName,
    memberCount: state.members.filter((m) => m.active).length,
    expenseCount: state.expenses.length,
    obligationCounts,
    paymentCount: state.payments.length,
    entryCount: counts.entryCount,
    headSeq: counts.headSeq,
    cached: true,
  };
}
