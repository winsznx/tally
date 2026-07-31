import { Address, KeyPair, PrivateKey, TransactionBuilder } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { RpcChain, RpcRateLimited, type FetchFn } from './chain-rpc.js';
import { StoredEntryCache, MemoryStore } from './cache.js';
import { FakeClock } from './clock.js';
import { FakeChain, FakeProvider, FakeRelay } from './fakes.js';
import { checkNetwork, showNetworkChip } from './network-guard.js';
import { NimiqPayProvider } from './provider.js';
import {
  buildManualLegParams,
  chooseIdempotencyStrategy,
  mayBroadcastUnderLock,
} from './settlement.js';
import { MAINNET, TESTNET } from './types.js';

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// A real serialized testnet tx to exercise provider deserialization.
function realSerializedTx(): { serialized: string; sender: string; hash: string } {
  const kp = KeyPair.derive(PrivateKey.fromHex('11'.repeat(32)));
  const recipient = KeyPair.derive(PrivateKey.fromHex('22'.repeat(32))).toAddress();
  const tx = TransactionBuilder.newBasic(kp.toAddress(), recipient, 100_000n, 0n, 1000, TESTNET);
  tx.sign(kp, undefined);
  return { serialized: tx.toHex(), sender: kp.toAddress().toUserFriendlyAddress(), hash: tx.hash() };
}

describe('provider: deserializes the returned serialized tx (docs say hash, wrong)', () => {
  it('recovers sender, hash, fee, vsh, networkId and sets declined/error as results', async () => {
    const { serialized, sender, hash } = realSerializedTx();
    const provider = new NimiqPayProvider();
    // inject a fake window.nimiq
    (globalThis as unknown as { window: unknown }).window = {
      nimiq: {
        sendBasicTransaction: async () => serialized,
        sign: async () => ({ error: { type: 'x', message: 'user rejected the request' } }),
      },
      nimiqPay: { language: 'de' },
    };
    await provider.init();
    const res = await provider.sendBasicTransaction({ recipient: 'NQ', value: 100_000n });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.value.sender).toBe(sender);
      expect(res.value.hash).toBe(hash);
      expect(res.value.fee).toBe(0n);
      expect(res.value.validityStartHeight).toBe(1000);
      expect(res.value.networkId).toBe(TESTNET);
    }
    expect(provider.detectedNetworkId).toBe(TESTNET);
    // a declined sign resolves to `declined`, never throws
    const sig = await provider.sign('hello');
    expect(sig.kind).toBe('declined');
    delete (globalThis as unknown as { window?: unknown }).window;
  });
});

describe('network guard (GAP 3)', () => {
  it('allows before detection, allows a match, refuses a mismatch with a clear message', () => {
    expect(checkNetwork(TESTNET, undefined).ok).toBe(true);
    expect(checkNetwork(TESTNET, TESTNET).ok).toBe(true);
    const bad = checkNetwork(TESTNET, MAINNET);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/testnet/);
  });
  it('shows the network chip only on testnet', () => {
    expect(showNetworkChip(TESTNET)).toBe(true);
    expect(showNetworkChip(MAINNET)).toBe(false);
  });
});

describe('RpcChain budget (GAP 4)', () => {
  function scriptedFetch(script: { status: number; body: unknown; remaining?: number }[]): {
    fn: FetchFn;
    calls: { method: string; params: unknown[] }[];
  } {
    const calls: { method: string; params: unknown[] }[] = [];
    let i = 0;
    const fn: FetchFn = async (_url, init) => {
      const parsed = JSON.parse(init.body) as { method: string; params: unknown[] };
      calls.push({ method: parsed.method, params: parsed.params });
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        status: step!.status,
        headers: { get: (n: string) => (n === 'x-ratelimit-remaining' ? String(step!.remaining ?? 50) : null) },
        json: async () => step!.body,
      };
    };
    return { fn, calls };
  }

  it('coalesces identical concurrent calls into one request', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: { result: { data: 1234 } } }]);
    const chain = new RpcChain({ url: 'https://rpc.testnet.example/', fetchFn: fn, minIntervalMs: 0, sleep: async () => {} });
    const [a, b, c] = await Promise.all([chain.headHeight(), chain.headHeight(), chain.headHeight()]);
    expect([a, b, c]).toEqual([1234, 1234, 1234]);
    expect(calls.length).toBe(1); // three callers, one network request
  });

  it('backs off on 429 then succeeds, and surfaces rate-limit remaining', async () => {
    const { fn } = scriptedFetch([
      { status: 429, body: {}, remaining: 0 },
      { status: 429, body: {}, remaining: 0 },
      { status: 200, body: { result: { data: 7 } }, remaining: 5 },
    ]);
    const slept: number[] = [];
    const chain = new RpcChain({
      url: 'https://rpc.testnet.example/',
      fetchFn: fn,
      minIntervalMs: 0,
      backoffBaseMs: 10,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(await chain.headHeight()).toBe(7);
    expect(slept).toEqual([10, 20]); // exponential backoff
    expect(chain.rateLimitRemaining).toBe(5);
  });

  it('throws RpcRateLimited after exhausting retries', async () => {
    const { fn } = scriptedFetch([{ status: 429, body: {}, remaining: 0 }]);
    const chain = new RpcChain({
      url: 'https://rpc.testnet.example/',
      fetchFn: fn,
      minIntervalMs: 0,
      maxRetries: 2,
      backoffBaseMs: 1,
      sleep: async () => {},
    });
    await expect(chain.headHeight()).rejects.toBeInstanceOf(RpcRateLimited);
  });

  it('marks a tx confirmed only past the macro-block (batch) boundary', async () => {
    // tx in block 970, batch size 60 → next macro at 1020. Head 1000 → not final.
    const { fn } = scriptedFetch([
      { status: 200, body: { result: { data: 1000 } } }, // headHeight
      { status: 200, body: { result: { data: [{ transactionHash: 'aa', blockNumber: 970, value: 5 }] } } },
    ]);
    const chain = new RpcChain({ url: 'https://rpc.testnet.example/', fetchFn: fn, minIntervalMs: 0, sleep: async () => {}, blocksPerBatch: 60 });
    const [tx] = await chain.getTransactionsByAddress('NQ');
    expect(tx!.confirmed).toBe(false);
    expect(tx!.value).toBe(5n);
  });
});

describe('settlement Test M branch', () => {
  it('purse mode is always deterministic; manual depends on the probe', () => {
    expect(chooseIdempotencyStrategy('purse', false)).toBe('deterministic');
    expect(chooseIdempotencyStrategy('manual', true)).toBe('deterministic');
    expect(chooseIdempotencyStrategy('manual', false)).toBe('locked');
  });
  it('manual leg params carry explicit fee 0 and the round anchor height', () => {
    const p = buildManualLegParams({ recipient: 'NQ', value: 30_000n, anchor: 'TLY1...', anchorHeight: 41200 });
    expect(p.fee).toBe(0n);
    expect(p.validityStartHeight).toBe(41200);
    expect(p.data).toBe('TLY1...');
  });
  it('under lock, an already-broadcast leg warns instead of re-broadcasting', () => {
    expect(mayBroadcastUnderLock('r1:leg2', new Set())).toEqual({ broadcast: true, warn: false });
    expect(mayBroadcastUnderLock('r1:leg2', new Set(['r1:leg2']))).toEqual({ broadcast: false, warn: true });
  });
});

describe('cache degrades to read-only', () => {
  it('round-trips entries and survives a corrupt store', () => {
    const store = new MemoryStore();
    const cache = new StoredEntryCache(store);
    cache.save('L1', ['{"a":1}', '{"b":2}']);
    expect(new StoredEntryCache(store).load('L1')).toEqual(['{"a":1}', '{"b":2}']);
    store.setItem('tally.log.bad', '{not json');
    expect(cache.load('bad')).toEqual([]);
    expect(cache.load('missing')).toEqual([]);
  });
});

describe('fakes let flows run with no phone or network', () => {
  it('relay is idempotent on entry id and counts distinct accounts (GAP 6)', async () => {
    const relay = new FakeRelay();
    const { ledgerId } = await relay.createLedger(TESTNET);
    const entry = JSON.stringify({ authorAddress: 'acct-a', prevEntryHash: null });
    await relay.append(ledgerId, [entry, entry]); // duplicate collapses
    await relay.append(ledgerId, [JSON.stringify({ authorAddress: 'acct-b', prevEntryHash: 'e0' })]);
    expect((await relay.getSince(ledgerId, null)).length).toBe(2);
    expect(await relay.stats()).toBe(2);
  });
  it('fake provider surfaces declined and error as results', async () => {
    const p = new FakeProvider();
    p.nextOutcome = 'declined';
    expect((await p.sendBasicTransaction({ recipient: 'NQ', value: 1n })).kind).toBe('declined');
    p.nextOutcome = 'error';
    expect((await p.sign('x')).kind).toBe('error');
  });
  it('fake chain and clock support offline flow tests', async () => {
    const chain = new FakeChain(TESTNET);
    chain.balances.set('NQ-a', 500n);
    expect(await chain.getBalance('NQ-a')).toBe(500n);
    const clock = new FakeClock(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    void Address; // keep import used across type-only paths
    void hex;
  });
});
