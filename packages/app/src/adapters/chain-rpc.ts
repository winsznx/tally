/**
 * RPC chain adapter. RPC-first reads against the public testnet endpoint, which
 * is rate-limited and unreliable (Phase 0 saw `x-ratelimit-remaining: 18`), so
 * this adapter is defensive by construction (GAP 4):
 *   - request coalescing: identical in-flight calls share one promise
 *   - a single throttle so calls are spaced, never bursted
 *   - exponential backoff on 429, treating a rate-limit as a transient STATE
 *   - one poll loop per app instance (the caller owns the loop; this only
 *     throttles), and never polls while backgrounded (the caller stops calling)
 *
 * The HTTP call is injected so this is fully testable with no network.
 */
import {
  MAINNET,
  TESTNET,
  type ChainAdapter,
  type ChainTx,
  type NetworkId,
} from './types.js';

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface RpcChainOptions {
  url: string;
  fetchFn?: FetchFn;
  /** Minimum ms between requests (throttle). Default 600. */
  minIntervalMs?: number;
  /** Max backoff retries on 429/5xx. Default 4. */
  maxRetries?: number;
  /** Base backoff ms, doubled each retry. Default 800. */
  backoffBaseMs?: number;
  /** Sleep function, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Now function, injectable for tests. */
  now?: () => number;
  /**
   * Blocks per batch — macro-block finality lands at the next batch boundary.
   * Albatross default 60; a tx is only `confirmed` once head reaches it.
   */
  blocksPerBatch?: number;
}

export class RpcRateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('rpc rate limited');
    this.name = 'RpcRateLimited';
  }
}

interface RpcResult {
  result?: { data?: unknown; metadata?: unknown } | unknown;
  error?: unknown;
}

export class RpcChain implements ChainAdapter {
  readonly #url: string;
  readonly #fetch: FetchFn;
  readonly #minInterval: number;
  readonly #maxRetries: number;
  readonly #backoffBase: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #blocksPerBatch: number;

  #lastRequestAt = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #inflight = new Map<string, Promise<unknown>>();
  #rateLimitRemaining: number | undefined;

  constructor(opts: RpcChainOptions) {
    this.#url = opts.url;
    this.#fetch = opts.fetchFn ?? defaultFetch;
    this.#minInterval = opts.minIntervalMs ?? 600;
    this.#maxRetries = opts.maxRetries ?? 4;
    this.#backoffBase = opts.backoffBaseMs ?? 800;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? Date.now;
    this.#blocksPerBatch = opts.blocksPerBatch ?? 60;
  }

  get rateLimitRemaining(): number | undefined {
    return this.#rateLimitRemaining;
  }

  async #call<T>(method: string, params: unknown[]): Promise<T> {
    // Coalesce identical concurrent calls onto one promise.
    const key = `${method}:${JSON.stringify(params)}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = this.#throttledCall<T>(method, params).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  /** Serialize + space out requests through a single chain (one throttle). */
  #throttledCall<T>(method: string, params: unknown[]): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.#minInterval - (this.#now() - this.#lastRequestAt);
      if (wait > 0) await this.#sleep(wait);
      return this.#withBackoff<T>(method, params);
    };
    const result = this.#chain.then(run, run);
    // keep the chain alive regardless of individual failures
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #withBackoff<T>(method: string, params: unknown[]): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.#lastRequestAt = this.#now();
      const resp = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const remaining = resp.headers.get('x-ratelimit-remaining');
      if (remaining !== null) this.#rateLimitRemaining = Number(remaining);

      if (resp.status === 429 || resp.status >= 500) {
        if (attempt >= this.#maxRetries) throw new RpcRateLimited(this.#backoffBase * 2 ** attempt);
        await this.#sleep(this.#backoffBase * 2 ** attempt);
        attempt += 1;
        continue;
      }
      const json = (await resp.json()) as RpcResult;
      if (json.error !== undefined) {
        throw new Error(`rpc ${method} error: ${JSON.stringify(json.error)}`);
      }
      const result = json.result as { data?: unknown } | undefined;
      return (result && typeof result === 'object' && 'data' in result ? result.data : json.result) as T;
    }
  }

  async headHeight(): Promise<number> {
    return this.#call<number>('getBlockNumber', []);
  }

  async networkId(): Promise<NetworkId> {
    // The public server does not expose a network method; the endpoint IS the
    // network. Callers pass the endpoint per network, so we trust configuration
    // and cross-check against wallet-returned txs elsewhere.
    return this.#url.includes('testnet') ? TESTNET : MAINNET;
  }

  async getBalance(address: string): Promise<bigint> {
    const acct = await this.#call<{ balance?: number; type?: string }>('getAccountByAddress', [address]);
    return BigInt(acct?.balance ?? 0);
  }

  async getTransactionsByAddress(address: string, max = 100, startAt: string | null = null): Promise<ChainTx[]> {
    const head = await this.headHeight();
    const rows = await this.#call<PlainRpcTx[]>('getTransactionsByAddress', [address, max, startAt]);
    return (rows ?? []).map((r) => toChainTx(r, head, this.#blocksPerBatch));
  }

  async getTransactionByHash(hash: string): Promise<ChainTx | null> {
    try {
      const head = await this.headHeight();
      const r = await this.#call<PlainRpcTx>('getTransactionByHash', [hash]);
      return r ? toChainTx(r, head, this.#blocksPerBatch) : null;
    } catch {
      return null; // "Transaction not found" is a normal negative, not a failure
    }
  }

  async broadcast(serializedHex: string): Promise<{ hash: string }> {
    const hash = await this.#call<string>('sendRawTransaction', [serializedHex]);
    return { hash };
  }
}

interface PlainRpcTx {
  hash?: string;
  transactionHash?: string;
  from?: string;
  sender?: string;
  to?: string;
  recipient?: string;
  value?: number;
  validityStartHeight?: number;
  blockNumber?: number;
  blockHeight?: number;
  confirmations?: number;
  data?: string;
  recipientData?: string;
}

/** A tx is confirmed only once head has passed the batch boundary above its block. */
function isMacroFinalized(txBlock: number | undefined, head: number, blocksPerBatch: number): boolean {
  if (txBlock === undefined || txBlock <= 0) return false;
  const nextMacro = Math.ceil(txBlock / blocksPerBatch) * blocksPerBatch;
  return head >= nextMacro;
}

function toChainTx(r: PlainRpcTx, head: number, blocksPerBatch: number): ChainTx {
  const blockHeight = r.blockNumber ?? r.blockHeight;
  return {
    hash: (r.transactionHash ?? r.hash ?? '').toLowerCase(),
    sender: r.sender ?? r.from ?? '',
    recipient: r.recipient ?? r.to ?? '',
    value: BigInt(r.value ?? 0),
    validityStartHeight: r.validityStartHeight ?? 0,
    blockHeight,
    confirmed: isMacroFinalized(blockHeight, head, blocksPerBatch),
    dataHex: r.recipientData ?? r.data,
  };
}

const defaultFetch: FetchFn = (url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>;
