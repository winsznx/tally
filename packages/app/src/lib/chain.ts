/**
 * Read-only chain access from the browser, against a public Albatross JSON-RPC
 * endpoint. This is the client's own, independent look at the chain: payment
 * status never rests on the backend's word or a wallet-returned hash.
 *
 * The public endpoint rate-limits (about 20 calls per window), so calls are
 * serialised, spaced, coalesced, and backed off on 429/5xx.
 */
import type { ObservedTransaction } from '@tally/core/settle';

interface RpcTx {
  hash: string;
  blockNumber?: number;
  from: string;
  to: string;
  value: number;
  recipientData?: string;
  networkId: number;
  executionResult?: boolean;
  timestamp?: number;
}

export class ChainUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainUnavailable';
  }
}

export interface ChainReader {
  headHeight(): Promise<number>;
  transaction(hash: string): Promise<(ObservedTransaction & { timestamp: number | null }) | null>;
  incomingTransactions(addressFriendly: string, max: number): Promise<(ObservedTransaction & { timestamp: number | null })[]>;
}

type Fetch = typeof fetch;

export class RpcChainReader implements ChainReader {
  #queue: Promise<unknown> = Promise.resolve();
  #last = 0;
  #inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly url: string,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
    private readonly minIntervalMs = 350,
  ) {}

  #call<T>(method: string, params: unknown[]): Promise<T> {
    const key = `${method}:${JSON.stringify(params)}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing as Promise<T>;
    const run = async (): Promise<T> => {
      const wait = this.minIntervalMs - (Date.now() - this.#last);
      if (wait > 0) await sleep(wait);
      return this.#withRetry<T>(method, params);
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    const tracked = p.finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, tracked);
    return tracked;
  }

  async #withRetry<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.#last = Date.now();
      let res: Response;
      try {
        res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      } catch {
        if (attempt >= 2) throw new ChainUnavailable('Could not reach the Nimiq network.');
        await sleep(600 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 3) throw new ChainUnavailable('The Nimiq network endpoint is busy. Tally will check again shortly.');
        await sleep(800 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      const body = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } };
      if (body.error) throw new RpcError(body.error.message ?? 'RPC error');
      return (body.result?.data ?? null) as T;
    }
  }

  headHeight(): Promise<number> {
    return this.#call<number>('getBlockNumber', []);
  }

  async transaction(hash: string): Promise<(ObservedTransaction & { timestamp: number | null }) | null> {
    try {
      const tx = await this.#call<RpcTx | null>('getTransactionByHash', [hash]);
      return tx ? toObserved(tx) : null;
    } catch (e) {
      if (e instanceof RpcError) return null;
      throw e;
    }
  }

  async incomingTransactions(addressFriendly: string, max: number): Promise<(ObservedTransaction & { timestamp: number | null })[]> {
    const rows = await this.#call<RpcTx[] | null>('getTransactionsByAddress', [addressFriendly, max, null]);
    return (rows ?? []).map(toObserved);
  }
}

class RpcError extends Error {}

function toObserved(tx: RpcTx): ObservedTransaction & { timestamp: number | null } {
  return {
    hash: tx.hash.toLowerCase(),
    from: tx.from,
    to: tx.to,
    value: BigInt(tx.value),
    recipientData: tx.recipientData ?? '',
    networkId: tx.networkId,
    blockNumber: typeof tx.blockNumber === 'number' && tx.blockNumber > 0 ? tx.blockNumber : null,
    executionResult: typeof tx.executionResult === 'boolean' ? tx.executionResult : null,
    timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
