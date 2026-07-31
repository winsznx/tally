/**
 * Relay HTTP client. The relay is UNTRUSTED and may be down. This adapter only
 * moves bytes; every entry it returns is re-verified by the caller (the log
 * module's validateEntry) before it touches state — the relay's own signature
 * check is a spam filter, never a trust anchor. On failure the caller falls back
 * to cached log state rather than surfacing an error page.
 *
 * The HTTP call is injected so this is testable with no network.
 */
import { type NetworkId, type RelayAdapter, type RelayEntry } from './types.js';

export type RelayFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

export class RelayUnreachable extends Error {
  constructor(cause: string) {
    super(`relay unreachable: ${cause}`);
    this.name = 'RelayUnreachable';
  }
}

export class HttpRelay implements RelayAdapter {
  readonly #base: string;
  readonly #fetch: RelayFetch;

  constructor(baseUrl: string, fetchFn?: RelayFetch) {
    this.#base = baseUrl.replace(/\/$/, '');
    // Wrap rather than capture: `fetch` must be invoked with the global as its
    // receiver. Storing it bare and calling `this.#fetch(...)` makes the adapter
    // the receiver, which browsers reject with "Illegal invocation" while Node
    // and injected test doubles happily allow, so it only breaks in production.
    this.#fetch =
      fetchFn ?? ((url, init) => globalThis.fetch(url, init as RequestInit) as unknown as ReturnType<RelayFetch>);
  }

  async #json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    let resp;
    try {
      resp = await this.#fetch(`${this.#base}${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      throw new RelayUnreachable(e instanceof Error ? e.message : String(e));
    }
    if (!resp.ok) throw new RelayUnreachable(`HTTP ${resp.status} on ${path}`);
    return (await resp.json()) as T;
  }

  async createLedger(network: NetworkId): Promise<{ ledgerId: string; network: NetworkId }> {
    return this.#json('/l', { method: 'POST', body: { network } });
  }

  async getHead(ledgerId: string): Promise<string | null> {
    const r = await this.#json<{ head: string | null }>(`/l/${encodeURIComponent(ledgerId)}/head`);
    return r.head;
  }

  async getSince(ledgerId: string, sinceHash: string | null): Promise<RelayEntry[]> {
    const cursor = sinceHash ?? 'genesis';
    const r = await this.#json<{ entries: RelayEntry[] }>(
      `/l/${encodeURIComponent(ledgerId)}/since/${encodeURIComponent(cursor)}`,
    );
    return r.entries;
  }

  async append(ledgerId: string, entriesJson: string[]): Promise<void> {
    // The wire format is an array of OBJECTS, not of JSON strings: the Worker
    // validates each record's fields and signature directly. Posting the
    // stringified form makes the relay reject every append, silently.
    const entries = entriesJson.map((e) => JSON.parse(e) as unknown);
    await this.#json(`/l/${encodeURIComponent(ledgerId)}/entries`, { method: 'POST', body: { entries } });
  }

  async stats(): Promise<number> {
    const r = await this.#json<{ uniqueAccounts: number }>('/stats');
    return r.uniqueAccounts;
  }
}
