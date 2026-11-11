import { KeyPair, PrivateKey } from '@nimiq/core';
import { createBindingAttestation } from '@tally/core/binding';
import type { ObservedTransaction } from '@tally/core/settle';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainReader } from './chain.js';
import type { Identity } from './identity.js';
import { PaymentBlocked, PaymentController, VALIDITY_WINDOW_BLOCKS, paymentStatus, type PaymentApi } from './payments.js';
import { TabStore, authorEntry } from './tab.js';
import { WalletError, type PaymentRequest, type WalletPort } from './wallet/port.js';

vi.mock('./api.js', () => ({
  ApiError: class extends Error {},
  ApiUnreachable: class extends Error {},
  api: {
    getAllEntries: vi.fn(async () => ({ rows: [], lastSeq: null })),
    appendEntries: vi.fn(async (_tab: string, entries: unknown[]) => ({ accepted: entries.length, duplicates: 0, rejected: [] })),
  },
}));

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function identity(seed: string): Identity {
  const account = KeyPair.derive(PrivateKey.fromHex(seed.repeat(32)));
  const session = KeyPair.derive(PrivateKey.fromHex(seed.split('').reverse().join('').repeat(32)));
  const attestation = createBindingAttestation(account, bytesToHex(session.publicKey.serialize()), 2);
  return { address: attestation.accountAddress, session, attestation };
}

const ada = identity('a1');
const bo = identity('b2');
let tabCounter = 0;

async function tab(): Promise<TabStore> {
  const store = new TabStore(`tab${++tabCounter}`.padEnd(26, 'a'));
  await store.open(ada, { name: 'Trip' });
  await store.append(bo, 'MEMBER_JOIN', {});
  return store;
}

class FakeChain implements ChainReader {
  head = 1_000;
  txs = new Map<string, ObservedTransaction & { timestamp: number | null }>();
  incoming: (ObservedTransaction & { timestamp: number | null })[] = [];
  down = false;
  async headHeight(): Promise<number> {
    return this.head;
  }
  async transaction(hash: string) {
    return this.txs.get(hash) ?? null;
  }
  async incomingTransactions() {
    return this.incoming;
  }
}

class FakeWallet implements WalletPort {
  sent: PaymentRequest[] = [];
  next: (req: PaymentRequest) => Promise<{ txHash: string }> = async () => ({ txHash: 'ab'.repeat(32) });
  async initialize() {
    return { inHost: true, network: 'mainnet' as const, language: null, canReadBalance: true, walletKind: 'nimiq-pay' as const };
  }
  async requestAccounts() {
    return { walletAddress: 'x', htlcAddress: null };
  }
  async signMessage(): Promise<never> {
    throw new Error('unused');
  }
  async getBalance() {
    return null;
  }
  async getBlockNumber() {
    return null;
  }
  async sendNim(req: PaymentRequest) {
    this.sent.push(req);
    return this.next(req);
  }
  onAccountsChanged() {
    return () => undefined;
  }
}

const api: PaymentApi = {
  createIntent: vi.fn(async (b) => ({ ...b, id: `srv-${b.ref}`, memo: '', txHash: null, state: 'created' })),
  submitIntent: vi.fn(async (id, txHash) => ({ id, txHash } as never)),
  markIntentUnknown: vi.fn(async (id) => ({ id } as never)),
};

function memoHex(memo: string): string {
  return bytesToHex(new TextEncoder().encode(memo));
}

describe('PaymentController', () => {
  let chain: FakeChain;
  let wallet: FakeWallet;
  beforeEach(() => {
    chain = new FakeChain();
    wallet = new FakeWallet();
  });

  it('records a submitted payment but does not count it until the chain confirms it', async () => {
    const store = await tab();
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    const intent = await pc.pay(bo, ada.address, 150_000n);
    expect(intent.phase).toBe('submitted');
    expect(wallet.sent[0]?.memo).toBe(intent.memo);
    expect(store.snapshot.state.payments).toHaveLength(1);
    expect(paymentStatus(intent, null)).toBe('submitted');

    chain.txs.set(intent.txHash as string, {
      hash: intent.txHash as string,
      from: 'NQ00 0000',
      to: ada.address,
      value: 150_000n,
      recipientData: memoHex(intent.memo),
      networkId: 24,
      blockNumber: 1_001,
      executionResult: true,
      timestamp: null,
    });
    await pc.verifyClaims();
    expect(store.snapshot.verifications.get(intent.txHash as string)?.status).toBe('observed');
    chain.head = 1_100;
    await pc.verifyClaims();
    expect(store.snapshot.verifications.get(intent.txHash as string)?.status).toBe('confirmed');
    expect(paymentStatus(intent, 'confirmed')).toBe('confirmed');
  });

  it('refuses a second payment while the first is unresolved (double tap, second device)', async () => {
    const store = await tab();
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    await pc.pay(bo, ada.address, 10n);
    await expect(pc.pay(bo, ada.address, 10n)).rejects.toBeInstanceOf(PaymentBlocked);
    const second = new PaymentController(store, { wallet, chain, api, network: 24 });
    await expect(second.pay(bo, ada.address, 10n)).rejects.toBeInstanceOf(PaymentBlocked);
    expect(wallet.sent).toHaveLength(1);
  });

  it('treats a decline as a safe, retryable outcome with nothing recorded', async () => {
    const store = await tab();
    wallet.next = async () => {
      throw new WalletError('declined', 'no');
    };
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    const intent = await pc.pay(bo, ada.address, 10n);
    expect(intent.phase).toBe('declined');
    expect(store.snapshot.state.payments).toHaveLength(0);
    expect(pc.blockingPayment(bo.address)).toBeNull();
  });

  it('holds an uncertain send as unknown and blocks new payments until reconciled', async () => {
    const store = await tab();
    wallet.next = async () => {
      throw new WalletError('outcome_unknown', 'timeout');
    };
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    const intent = await pc.pay(bo, ada.address, 10n);
    expect(intent.phase).toBe('unknown');
    expect(paymentStatus(intent, null)).toBe('unknown');
    await expect(pc.pay(bo, ada.address, 10n)).rejects.toBeInstanceOf(PaymentBlocked);

    const stillUnknown = await pc.reconcile(bo, intent.id);
    expect(stillUnknown.phase).toBe('unknown');

    chain.incoming = [
      {
        hash: 'cd'.repeat(32),
        from: 'x',
        to: ada.address,
        value: 10n,
        recipientData: memoHex(intent.memo),
        networkId: 24,
        blockNumber: 1_002,
        executionResult: true,
        timestamp: null,
      },
    ];
    const found = await pc.reconcile(bo, intent.id);
    expect(found.phase).toBe('submitted');
    expect(found.txHash).toBe('cd'.repeat(32));
    expect(store.snapshot.state.payments.map((p) => p.txHash)).toEqual(['cd'.repeat(32)]);
  });

  it('releases an unknown payment only once it can no longer land', async () => {
    const store = await tab();
    wallet.next = async () => {
      throw new WalletError('outcome_unknown', 'lost');
    };
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    const intent = await pc.pay(bo, ada.address, 10n);
    chain.head = 1_000 + VALIDITY_WINDOW_BLOCKS;
    expect((await pc.reconcile(bo, intent.id)).phase).toBe('unknown');
    chain.head = 1_000 + VALIDITY_WINDOW_BLOCKS + 500;
    expect((await pc.reconcile(bo, intent.id)).phase).toBe('expired');
    expect(pc.blockingPayment(bo.address)).toBeNull();
  });

  it('turns an intent interrupted mid-prompt into unknown on the next open', async () => {
    const store = await tab();
    wallet.next = () => new Promise(() => undefined);
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    void pc.pay(bo, ada.address, 10n);
    await new Promise((r) => setTimeout(r, 10));
    expect(pc.intents[0]?.phase).toBe('awaiting_approval');
    const reopened = new PaymentController(store, { wallet, chain, api, network: 24 });
    expect(reopened.intents[0]?.phase).toBe('unknown');
  });

  it('never confirms a transaction whose amount does not match the claim', async () => {
    const store = await tab();
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    const intent = await pc.pay(bo, ada.address, 150_000n);
    chain.head = 5_000;
    chain.txs.set(intent.txHash as string, {
      hash: intent.txHash as string,
      from: 'x',
      to: ada.address,
      value: 149_999n,
      recipientData: memoHex(intent.memo),
      networkId: 24,
      blockNumber: 1_001,
      executionResult: true,
      timestamp: null,
    });
    await pc.verifyClaims();
    const v = store.snapshot.verifications.get(intent.txHash as string)?.status ?? null;
    expect(v).toBe('mismatch');
    expect(paymentStatus(intent, v)).toBe('failed');
    expect(store.snapshot.settlement.positions.get(bo.address)).toBe(0n);
  });

  it('refuses to pay someone outside the tab', async () => {
    const store = await tab();
    const pc = new PaymentController(store, { wallet, chain, api, network: 24 });
    await expect(pc.pay(bo, 'f'.repeat(40), 10n)).rejects.toThrow(/not an active member/);
    expect(wallet.sent).toHaveLength(0);
  });
});

describe('authorEntry', () => {
  it('chains onto the newest entry and advances the clock', async () => {
    const store = await tab();
    const e = authorEntry(ada, store.snapshot.entries, 'MEMBER_LEAVE', {});
    expect(e.logicalClock).toBe(2);
  });
});
