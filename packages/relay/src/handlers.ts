/**
 * Pure request handlers, independent of the Workers runtime so they test with an
 * in-memory store. Each verifies entry signatures (spam filter only — clients
 * re-verify), dedups on entryId, and never trusts client-supplied hashes for
 * anything but opaque cursors.
 */
import { isStructurallyValid, verifyEntrySignature, type RawLogEntry } from './entry.js';
import type { Store, StoredEntry } from './store.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 128-bit unguessable, base32, lowercase (GAP 7). Uses the CSPRNG. */
export function newLedgerId(random: (n: number) => Uint8Array): string {
  const bytes = random(16); // 128 bits
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = BASE32[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

export async function createLedger(
  store: Store,
  network: number,
  now: number,
  random: (n: number) => Uint8Array,
): Promise<HandlerResult> {
  if (network !== 5 && network !== 24) return { status: 400, body: { error: 'network must be 5 (testnet) or 24 (mainnet)' } };
  const ledgerId = newLedgerId(random);
  await store.createLedger(ledgerId, network, now);
  return { status: 200, body: { ledgerId, network } };
}

/** The append wire record: the signed entry plus its client-derived cursors. */
export interface AppendRecord extends RawLogEntry {
  entryId: string;
  entryHash: string;
}

export async function appendEntries(
  store: Store,
  ledgerId: string,
  records: unknown,
  now: number,
): Promise<HandlerResult> {
  const ledger = await store.getLedger(ledgerId);
  if (!ledger) return { status: 404, body: { error: 'no such ledger' } };
  if (!Array.isArray(records)) return { status: 400, body: { error: 'entries must be an array' } };
  if (records.length > 500) return { status: 413, body: { error: 'too many entries in one request' } };

  let accepted = 0;
  let rejected = 0;
  let head: string | null = null;
  for (const rec of records as AppendRecord[]) {
    if (
      typeof rec?.entryId !== 'string' ||
      typeof rec?.entryHash !== 'string' ||
      !/^[0-9a-f]{1,128}$/.test(rec.entryId) ||
      !/^[0-9a-f]{1,128}$/.test(rec.entryHash) ||
      !isStructurallyValid(rec)
    ) {
      rejected += 1;
      continue;
    }
    // Spam filter: reject entries whose signature does not verify. NOT relied
    // upon for correctness — clients re-verify every entry independently.
    if (!(await verifyEntrySignature(rec))) {
      rejected += 1;
      continue;
    }
    const stored: StoredEntry = {
      entryId: rec.entryId,
      entryHash: rec.entryHash,
      prevEntryHash: rec.prevEntryHash,
      authorAddress: rec.authorAddress,
      entryJson: JSON.stringify(stripCursors(rec)),
      receivedAt: now,
    };
    const inserted = await store.insertEntry(ledgerId, stored);
    if (inserted) {
      accepted += 1;
      head = rec.entryHash;
    }
  }
  if (head) await store.setHead(ledgerId, head, now);
  return { status: 200, body: { accepted, rejected } };
}

function stripCursors(rec: AppendRecord): RawLogEntry {
  const { entryId, entryHash, ...entry } = rec;
  void entryId;
  void entryHash;
  return entry;
}

export async function getHead(store: Store, ledgerId: string): Promise<HandlerResult> {
  if (!(await store.getLedger(ledgerId))) return { status: 404, body: { error: 'no such ledger' } };
  return { status: 200, body: { head: await store.getHead(ledgerId) } };
}

export async function getSince(store: Store, ledgerId: string, sinceHash: string | null): Promise<HandlerResult> {
  if (!(await store.getLedger(ledgerId))) return { status: 404, body: { error: 'no such ledger' } };
  const rows = await store.entriesSince(ledgerId, sinceHash);
  return {
    status: 200,
    body: {
      entries: rows.map((e) => ({
        entryId: e.entryId,
        prevEntryHash: e.prevEntryHash,
        authorAddress: e.authorAddress,
        entryJson: e.entryJson,
        receivedAt: e.receivedAt,
      })),
    },
  };
}

export async function getStats(store: Store): Promise<HandlerResult> {
  // GAP 6: the only quantitative rubric cell — distinct account addresses across
  // all ledgers. No tracking pixel, no PII beyond what is already public.
  return { status: 200, body: { uniqueAccounts: await store.distinctAuthors() } };
}
