/**
 * One tab's signed log on this device.
 *
 * The log is the only truth: every view is derived from it by replay, nothing is
 * stored twice. Entries from the server and from the local cache are re-verified
 * before they are used, so neither is trusted. Entries authored here are kept in
 * a pending queue until the server has them, so being offline never loses an
 * acceptance, and the screen says "waiting to sync" instead of pretending.
 */
import { entryHash, replayState, signEntry, validateEntry, type EntryType, type LedgerState, type LogEntry } from '@tally/core/log';
import { settlementView, type SettlementView, type Verification } from '@tally/core/settle';
import { ApiError, ApiUnreachable, api, type AppendResult } from './api.js';
import type { Identity } from './identity.js';
import { Observable } from './observable.js';
import { readJson, writeJson } from './storage.js';

export type SyncStatus = 'loading' | 'synced' | 'syncing' | 'offline' | 'not_found' | 'error';

export interface RejectedEntry {
  entry: LogEntry;
  reason: string;
}

export interface TabSnapshot {
  tabId: string;
  entries: LogEntry[];
  pending: LogEntry[];
  rejected: RejectedEntry[];
  sync: SyncStatus;
  syncError: string | null;
  lastSyncedAt: number | null;
  /** When the server first stored each entry, by entry hash. Absent while an entry waits to sync. */
  receivedAt: ReadonlyMap<string, number>;
  state: LedgerState;
  verifications: ReadonlyMap<string, Verification & { checkedAt: number; blockNumber: number | null; timestamp: number | null }>;
  settlement: SettlementView;
}

const entriesKey = (id: string): string => `tally.v2.tab.${id}.entries`;
const pendingKey = (id: string): string => `tally.v2.tab.${id}.pending`;
const verifKey = (id: string): string => `tally.v2.tab.${id}.verifications`;
const receivedKey = (id: string): string => `tally.v2.tab.${id}.received`;

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function verified(raw: unknown): LogEntry | null {
  try {
    const entry = (typeof raw === 'string' ? JSON.parse(raw) : raw) as LogEntry;
    validateEntry(entry);
    return entry;
  } catch {
    return null;
  }
}

function mergeEntries(...lists: LogEntry[][]): LogEntry[] {
  const byHash = new Map<string, LogEntry>();
  for (const list of lists) for (const e of list) byHash.set(entryHash(e), e);
  return [...byHash.values()].sort((a, b) => a.logicalClock - b.logicalClock || (entryHash(a) < entryHash(b) ? -1 : 1));
}

type StoredVerification = [string, Verification & { checkedAt: number; blockNumber: number | null; timestamp: number | null }];

/** Author a signed entry on top of `entries`, as `identity`. */
export function authorEntry(identity: Identity, entries: readonly LogEntry[], entryType: EntryType, payload: Record<string, unknown>): LogEntry {
  const registering = entryType === 'LEDGER_OPEN' || entryType === 'MEMBER_JOIN';
  const full = registering
    ? { ...payload, accountPublicKey: identity.attestation.accountPublicKey, bindingSignature: identity.attestation.bindingSignature }
    : payload;
  const head = entries.length ? entries[entries.length - 1] : undefined;
  const clock = entries.reduce((max, e) => Math.max(max, e.logicalClock), 0);
  const entry = signEntry(
    {
      prevEntryHash: entryType === 'LEDGER_OPEN' ? null : head ? entryHash(head) : null,
      entryType,
      payload: full,
      authorAddress: identity.address,
      pursePublicKey: bytesToHex(identity.session.publicKey.serialize()),
      nonce: randomHex(16),
      logicalClock: entryType === 'LEDGER_OPEN' ? 0 : clock + 1,
    },
    identity.session,
  );
  validateEntry(entry);
  return entry;
}

function derive(entries: LogEntry[], verifications: TabSnapshot['verifications']): Pick<TabSnapshot, 'state' | 'settlement'> {
  const state = replayState(entries);
  return { state, settlement: settlementView(state, verifications) };
}

export class TabStore extends Observable<TabSnapshot> {
  #syncing: Promise<void> | null = null;

  constructor(tabId: string) {
    const cached = (readJson<string[]>(entriesKey(tabId)) ?? []).map(verified).filter((e): e is LogEntry => e !== null);
    const pending = (readJson<string[]>(pendingKey(tabId)) ?? []).map(verified).filter((e): e is LogEntry => e !== null);
    const verifications = new Map(readJson<StoredVerification[]>(verifKey(tabId)) ?? []);
    const receivedAt = new Map(readJson<[string, number][]>(receivedKey(tabId)) ?? []);
    const entries = mergeEntries(cached, pending);
    super({
      tabId,
      entries,
      pending,
      rejected: [],
      sync: 'loading',
      syncError: null,
      lastSyncedAt: null,
      receivedAt,
      verifications,
      ...derive(entries, verifications),
    });
  }

  get tabId(): string {
    return this.state.tabId;
  }

  #persist(): void {
    writeJson(entriesKey(this.tabId), this.state.entries.map((e) => JSON.stringify(e)));
    writeJson(pendingKey(this.tabId), this.state.pending.map((e) => JSON.stringify(e)));
  }

  #replace(entries: LogEntry[], pending: LogEntry[], extra: Partial<TabSnapshot> = {}): void {
    this.set({ ...this.state, ...extra, entries, pending, ...derive(entries, extra.verifications ?? this.state.verifications) });
    this.#persist();
  }

  sync(): Promise<void> {
    this.#syncing ??= this.#doSync().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #doSync(): Promise<void> {
    this.patch({ sync: this.state.entries.length ? 'syncing' : 'loading' });
    try {
      const { rows } = await api.getAllEntries(this.tabId);
      const receivedAt = new Map(this.state.receivedAt);
      const remote: LogEntry[] = [];
      for (const r of rows) {
        const e = verified(r.entryJson);
        if (!e) continue;
        remote.push(e);
        const at = Date.parse(r.receivedAt);
        if (Number.isFinite(at)) receivedAt.set(entryHash(e), at);
      }
      writeJson(receivedKey(this.tabId), [...receivedAt.entries()]);
      this.#replace(mergeEntries(this.state.entries, remote), this.state.pending, { receivedAt });
      await this.#flush();
      this.patch({ sync: this.state.pending.length ? 'offline' : 'synced', syncError: null, lastSyncedAt: Date.now() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.patch({ sync: 'not_found', syncError: 'This tab does not exist, or the link is incomplete.' });
      } else if (e instanceof ApiUnreachable) {
        this.patch({ sync: 'offline', syncError: e.message });
      } else {
        this.patch({ sync: 'error', syncError: e instanceof Error ? e.message : 'Sync failed.' });
      }
    }
  }

  async #flush(): Promise<void> {
    const pending = this.state.pending;
    if (pending.length === 0) return;
    const result: AppendResult = await api.appendEntries(this.tabId, pending);
    const rejected: RejectedEntry[] = result.rejected.map((r) => ({
      entry: pending[r.index] as LogEntry,
      reason: r.message,
    }));
    const sent = new Set(pending.map(entryHash));
    const rejectedHashes = new Set(rejected.map((r) => entryHash(r.entry)));
    const entries = this.state.entries.filter((e) => !rejectedHashes.has(entryHash(e)));
    const stillPending = this.state.pending.filter((e) => !sent.has(entryHash(e)));
    this.#replace(entries, stillPending, {
      rejected: [...this.state.rejected, ...rejected],
    });
  }

  /** Sign, apply locally, queue for the server, and try to send now. */
  async append(identity: Identity, entryType: EntryType, payload: Record<string, unknown>): Promise<LogEntry> {
    const entry = authorEntry(identity, this.state.entries, entryType, payload);
    const ignoredBefore = this.state.state.ignored.length;
    const entries = mergeEntries(this.state.entries, [entry]);
    const state = replayState(entries);
    if (state.ignored.length > ignoredBefore) {
      throw new Error(state.ignored[state.ignored.length - 1]?.reason ?? 'That change is not allowed.');
    }
    this.#replace(entries, [...this.state.pending, entry]);
    try {
      await this.#flush();
      this.patch({ sync: 'synced', syncError: null, lastSyncedAt: Date.now() });
    } catch (e) {
      this.patch({ sync: 'offline', syncError: e instanceof Error ? e.message : 'Waiting to sync.' });
    }
    return entry;
  }

  /** Seed a brand-new tab with its genesis entry (the creator's LEDGER_OPEN). */
  async open(identity: Identity, payload: Record<string, unknown>): Promise<LogEntry> {
    return this.append(identity, 'LEDGER_OPEN', payload);
  }

  setVerification(txHash: string, v: Verification & { checkedAt: number; blockNumber: number | null; timestamp: number | null }): void {
    const verifications = new Map(this.state.verifications);
    verifications.set(txHash, v);
    writeJson<StoredVerification[]>(verifKey(this.tabId), [...verifications.entries()]);
    this.set({ ...this.state, verifications, ...derive(this.state.entries, verifications) });
  }

  dismissRejected(): void {
    this.patch({ rejected: [] });
  }
}

const stores = new Map<string, TabStore>();

export function tabStore(tabId: string): TabStore {
  let s = stores.get(tabId);
  if (!s) {
    s = new TabStore(tabId);
    stores.set(tabId, s);
  }
  return s;
}
