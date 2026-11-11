import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcTransaction {
  hash: string;
  from: string;
  to: string;
  value: number;
  recipientData: string;
  networkId: number;
  blockNumber: number | null;
  executionResult: boolean | null;
}

export interface TransactionLookup {
  /** Null when the node does not know the transaction yet. */
  tx: RpcTransaction | null;
  /** sha256 of the raw response body, kept as evidence of what the node said. */
  payloadDigest: string;
}

export interface ChainSource {
  readonly url: string;
  getBlockNumber(): Promise<number>;
  getTransactionByHash(hash: string): Promise<TransactionLookup>;
}

export interface NimiqRpcOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  /** Minimum gap between two calls; the public endpoint rate-limits per IP. */
  minIntervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

const envelope = z.object({
  result: z.object({ data: z.unknown() }).optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

const transactionSchema = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: z.number().int().nonnegative(),
  recipientData: z.string().default(''),
  networkId: z.number().int(),
  blockNumber: z.number().int().nullable().optional(),
  executionResult: z.boolean().nullable().optional(),
});

const TX_NOT_FOUND = /transaction not found/i;

/**
 * Albatross JSON-RPC client. Calls are serialised with a minimum spacing and
 * retried with jittered exponential backoff on 429, 5xx and network errors.
 */
export class NimiqRpc implements ChainSource {
  readonly url: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;
  private nextId = 1;

  constructor(options: NimiqRpcOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.minIntervalMs = options.minIntervalMs ?? 400;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getBlockNumber(): Promise<number> {
    const { body } = await this.call('getBlockNumber', []);
    if (body.error) throw new RpcError(`getBlockNumber: ${describe(body.error)}`);
    const height = z.number().int().nonnegative().safeParse(body.result?.data);
    if (!height.success) throw new RpcError('getBlockNumber: malformed result');
    return height.data;
  }

  async getTransactionByHash(hash: string): Promise<TransactionLookup> {
    const { body, raw } = await this.call('getTransactionByHash', [hash]);
    const payloadDigest = createHash('sha256').update(raw).digest('hex');
    if (body.error) {
      if (TX_NOT_FOUND.test(`${body.error.message} ${String(body.error.data ?? '')}`)) return { tx: null, payloadDigest };
      throw new RpcError(`getTransactionByHash: ${describe(body.error)}`);
    }
    const parsed = transactionSchema.safeParse(body.result?.data);
    if (!parsed.success) throw new RpcError('getTransactionByHash: malformed transaction');
    const t = parsed.data;
    return {
      tx: {
        hash: t.hash,
        from: t.from,
        to: t.to,
        value: t.value,
        recipientData: t.recipientData,
        networkId: t.networkId,
        blockNumber: t.blockNumber ?? null,
        executionResult: t.executionResult ?? null,
      },
      payloadDigest,
    };
  }

  private call(method: string, params: unknown[]): Promise<{ body: z.output<typeof envelope>; raw: string }> {
    const run = this.queue.then(() => this.callWithRetry(method, params));
    // The caller sees a failure through `run`; the queue only orders calls.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callWithRetry(method: string, params: unknown[]): Promise<{ body: z.output<typeof envelope>; raw: string }> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCallAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      let failure: string;
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const raw = await res.text();
        if (res.ok) {
          const body = envelope.safeParse(safeJson(raw));
          if (!body.success) throw new RpcError(`${method}: response is not JSON-RPC`);
          return { body: body.data, raw };
        }
        if (res.status !== 429 && res.status < 500) throw new RpcError(`${method}: HTTP ${res.status}`);
        failure = `HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof RpcError) throw err;
        failure = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= this.maxRetries) throw new RpcError(`${method}: ${failure}`);
      const backoff = this.retryBaseMs * 2 ** attempt;
      await sleep(backoff / 2 + Math.random() * backoff);
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describe(error: { code: number; message: string; data?: unknown }): string {
  return `${error.code} ${error.message}${typeof error.data === 'string' ? `: ${error.data}` : ''}`;
}
