import { describe, expect, it } from 'vitest';
import { NimiqRpc, RpcError } from '../src/rpc.js';

type Handler = (body: { id: number; method: string; params: unknown[] }) => Response;

function rpcWith(handlers: Handler[], options: { minIntervalMs?: number; maxRetries?: number } = {}) {
  const calls: number[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls.push(Date.now());
    const handler = handlers[Math.min(i++, handlers.length - 1)] as Handler;
    return handler(JSON.parse(String(init?.body)));
  };
  const rpc = new NimiqRpc({
    url: 'http://fake',
    fetch,
    minIntervalMs: options.minIntervalMs ?? 0,
    maxRetries: options.maxRetries ?? 2,
    retryBaseMs: 1,
  });
  return { rpc, calls };
}

const ok = (data: unknown): Handler => (b) => Response.json({ jsonrpc: '2.0', id: b.id, result: { data, metadata: null } });

describe('NimiqRpc', () => {
  it('maps a real mainnet transaction shape', async () => {
    const tx = {
      hash: '7916'.padEnd(64, '0'),
      blockNumber: 66640210,
      timestamp: 1794425480468,
      confirmations: 64,
      from: 'NQ16 2SSN 0000 0000 0000 0000 0000 0000 0000',
      fromType: 0,
      to: 'NQ51 KNY3 0000 0000 0000 0000 0000 0000 0000',
      toType: 0,
      value: 154097,
      fee: 0,
      senderData: '',
      recipientData: '596f75',
      flags: 0,
      validityStartHeight: 66640202,
      networkId: 24,
      executionResult: true,
    };
    const { rpc } = rpcWith([ok(tx)]);
    const { tx: mapped, payloadDigest } = await rpc.getTransactionByHash(tx.hash);
    expect(mapped).toEqual({
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: 154097,
      recipientData: '596f75',
      networkId: 24,
      blockNumber: 66640210,
      executionResult: true,
    });
    expect(payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats "Transaction not found" as pending, not failure', async () => {
    const { rpc } = rpcWith([
      (b) =>
        Response.json({
          jsonrpc: '2.0',
          id: b.id,
          error: { code: -32603, message: 'Internal error', data: 'Transaction not found: aa' },
        }),
    ]);
    expect((await rpc.getTransactionByHash('aa'.repeat(32))).tx).toBeNull();
  });

  it('raises other JSON-RPC errors', async () => {
    const { rpc } = rpcWith([
      (b) => Response.json({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'Invalid params' } }),
    ]);
    await expect(rpc.getTransactionByHash('zz')).rejects.toBeInstanceOf(RpcError);
  });

  it('retries 429 and 5xx, then gives up', async () => {
    const retried = rpcWith([() => new Response('', { status: 429 }), () => new Response('', { status: 502 }), ok(42)]);
    expect(await retried.rpc.getBlockNumber()).toBe(42);
    expect(retried.calls).toHaveLength(3);

    const down = rpcWith([() => new Response('', { status: 503 })], { maxRetries: 1 });
    await expect(down.rpc.getBlockNumber()).rejects.toThrow(/HTTP 503/);
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry a 4xx other than 429', async () => {
    const { rpc, calls } = rpcWith([() => new Response('', { status: 400 })]);
    await expect(rpc.getBlockNumber()).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it('serialises calls with a minimum spacing', async () => {
    const { rpc, calls } = rpcWith([ok(1)], { minIntervalMs: 50 });
    await Promise.all([rpc.getBlockNumber(), rpc.getBlockNumber(), rpc.getBlockNumber()]);
    const gaps = calls.slice(1).map((t, i) => t - (calls[i] as number));
    expect(gaps.every((g) => g >= 45)).toBe(true);
  });
});
