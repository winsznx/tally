/**
 * Local cache of raw log entries per ledger, so a cold open with a dead relay
 * renders the ledger read-only from the last-known state rather than an error
 * page (a standing rule: degrade to something usable, never to a blank screen).
 * Storage is injected — localStorage in the app, in-memory in tests. Cached
 * entries are re-verified on load exactly like relay entries; the cache is not
 * a trust anchor either.
 */
export interface EntryCache {
  load(ledgerId: string): string[];
  save(ledgerId: string, entriesJson: string[]): void;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** In-memory KV, and the default for non-browser contexts. */
export class MemoryStore implements KeyValueStore {
  #m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#m.set(key, value);
  }
}

export class StoredEntryCache implements EntryCache {
  constructor(private readonly store: KeyValueStore = new MemoryStore()) {}
  #key(ledgerId: string): string {
    return `tally.log.${ledgerId}`;
  }
  load(ledgerId: string): string[] {
    const raw = this.store.getItem(this.#key(ledgerId));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  save(ledgerId: string, entriesJson: string[]): void {
    this.store.setItem(this.#key(ledgerId), JSON.stringify(entriesJson));
  }
}
