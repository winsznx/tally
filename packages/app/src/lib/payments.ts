/**
 * Paying a leg, and knowing whether it was paid.
 *
 * The two failures this module exists to prevent: paying twice, and believing a
 * payment happened when it did not. So:
 *
 *  - An intent is written to storage BEFORE the wallet prompt opens. If the app
 *    dies mid-prompt, the next open finds it and treats the outcome as unknown.
 *  - Each intent carries a payer-bound reference in its public memo. That is
 *    how an unknown outcome is reconciled: by looking for the memo on chain,
 *    never by guessing and never by building a different transaction.
 *  - While any of your payments in a tab is unresolved, a new one is refused.
 *  - "Paid" comes only from this device's own chain check (core/settle), never
 *    from a wallet-returned hash, the server, or another member's claim.
 */
import { paymentMemo, paymentRef, type PaymentClaim } from '@tally/core/log';
import { toUserFriendly, verifyPaymentTransaction, type VerificationStatus } from '@tally/core/settle';
import type { ServerIntent, ServerVerification } from './api.js';
import { ChainUnavailable, type ChainReader } from './chain.js';
import type { Identity } from './identity.js';
import { readJson, writeJson } from './storage.js';
import type { TabStore } from './tab.js';
import { WalletError, type WalletPort } from './wallet/port.js';

export type IntentPhase =
  | 'awaiting_approval'
  | 'declined'
  | 'rejected'
  | 'submitted'
  | 'unknown'
  | 'expired';

export interface LocalIntent {
  id: string;
  tabId: string;
  payer: string;
  recipient: string;
  amount: string;
  salt: string;
  ref: string;
  memo: string;
  phase: IntentPhase;
  txHash: string | null;
  createdAt: number;
  createdHeight: number | null;
  updatedAt: number;
  message: string | null;
  serverIntentId: string | null;
}

/** What the person sees. Only `confirmed` is ever shown as paid. */
export type PaymentStatus =
  | 'awaiting_user_approval'
  | 'declined'
  | 'submitted'
  | 'observed_unconfirmed'
  | 'confirmed'
  | 'unknown'
  | 'failed';

/** Albatross transaction validity window, plus a margin for slow inclusion. */
export const VALIDITY_WINDOW_BLOCKS = 7200;
const EXPIRY_MARGIN_BLOCKS = 120;
const TERMINAL: ReadonlySet<VerificationStatus> = new Set(['confirmed', 'failed', 'mismatch']);

export interface PaymentApi {
  createIntent(body: {
    tabId: string;
    payer: string;
    recipient: string;
    amount: string;
    ref: string;
    network: number;
    idempotencyKey: string;
  }): Promise<ServerIntent>;
  submitIntent(intentId: string, txHash: string): Promise<ServerIntent>;
  markIntentUnknown(intentId: string): Promise<ServerIntent>;
  verifyTransaction?(tabId: string, txHash: string): Promise<ServerVerification>;
}

export interface PaymentDeps {
  wallet: WalletPort;
  chain: ChainReader;
  api: PaymentApi;
  network: 5 | 24;
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

export class PaymentBlocked extends Error {
  constructor(
    message: string,
    readonly intent: LocalIntent | null,
  ) {
    super(message);
    this.name = 'PaymentBlocked';
  }
}

const intentsKey = (tabId: string): string => `tally.v2.tab.${tabId}.intents`;

function defaultRandomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function decodeMemo(hex: string): string | null {
  if (!hex || hex.length % 2 !== 0) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function loadIntents(tabId: string): LocalIntent[] {
  return readJson<LocalIntent[]>(intentsKey(tabId)) ?? [];
}

function saveIntents(tabId: string, intents: LocalIntent[]): void {
  writeJson(intentsKey(tabId), intents);
}

/** Map an intent plus the chain's verdict on its transaction to what the person sees. */
export function paymentStatus(intent: LocalIntent, verification: VerificationStatus | null): PaymentStatus {
  switch (intent.phase) {
    case 'awaiting_approval':
      return 'awaiting_user_approval';
    case 'declined':
      return 'declined';
    case 'rejected':
    case 'expired':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'submitted':
      if (verification === 'confirmed') return 'confirmed';
      if (verification === 'observed') return 'observed_unconfirmed';
      if (verification === 'failed' || verification === 'mismatch') return 'failed';
      return 'submitted';
  }
}

export class PaymentController {
  readonly #now: () => number;
  readonly #randomHex: (bytes: number) => string;

  constructor(
    private readonly store: TabStore,
    private readonly deps: PaymentDeps,
  ) {
    this.#now = deps.now ?? Date.now;
    this.#randomHex = deps.randomHex ?? defaultRandomHex;
    this.#recoverInterrupted();
  }

  get intents(): LocalIntent[] {
    return loadIntents(this.store.tabId);
  }

  #update(id: string, patch: Partial<LocalIntent>): LocalIntent {
    const intents = this.intents;
    const i = intents.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('payment intent vanished from storage');
    const next = { ...(intents[i] as LocalIntent), ...patch, updatedAt: this.#now() };
    intents[i] = next;
    saveIntents(this.store.tabId, intents);
    return next;
  }

  /** An app killed while the wallet prompt was open left an intent mid-flight: its outcome is unknown. */
  #recoverInterrupted(): void {
    for (const intent of this.intents) {
      if (intent.phase === 'awaiting_approval') {
        this.#update(intent.id, { phase: 'unknown', message: 'Tally closed while Nimiq Pay was asking you to approve this payment.' });
      }
    }
  }

  #claimFor(txHash: string): PaymentClaim | undefined {
    return this.store.snapshot.state.payments.find((p) => p.txHash === txHash);
  }

  /** The payment of yours in this tab that must resolve before another may start, if any. */
  blockingPayment(payer: string): { intent: LocalIntent | null; claim: PaymentClaim | null } | null {
    const verifications = this.store.snapshot.verifications;
    for (const intent of this.intents) {
      if (intent.payer !== payer) continue;
      if (intent.phase === 'awaiting_approval' || intent.phase === 'unknown') return { intent, claim: null };
      if (intent.phase === 'submitted' && intent.txHash) {
        const v = verifications.get(intent.txHash)?.status;
        if (!v || !TERMINAL.has(v)) return { intent, claim: this.#claimFor(intent.txHash) ?? null };
      }
    }
    for (const claim of this.store.snapshot.state.payments) {
      if (claim.payer !== payer) continue;
      const v = verifications.get(claim.txHash)?.status;
      if (!v || !TERMINAL.has(v)) return { intent: null, claim };
    }
    return null;
  }

  /**
   * Pay one leg. Resolves with the intent in its new phase; declines and
   * pre-prompt rejections are normal outcomes, not exceptions.
   */
  async pay(identity: Identity, recipient: string, amount: bigint): Promise<LocalIntent> {
    const { state } = this.store.snapshot;
    if (!state.genesisHash) throw new Error('This tab has not finished loading.');
    if (!state.members.some((m) => m.address === recipient && m.active)) throw new Error('That person is not an active member of this tab.');
    const blocking = this.blockingPayment(identity.address);
    if (blocking) {
      throw new PaymentBlocked('Your previous payment in this tab is still being checked. Tally will not start another until it resolves.', blocking.intent);
    }

    const salt = this.#randomHex(16);
    const ref = paymentRef(identity.address, salt);
    const memo = paymentMemo(state.genesisHash, ref);
    let createdHeight: number | null = null;
    try {
      createdHeight = await this.deps.chain.headHeight();
    } catch {
      createdHeight = await this.deps.wallet.getBlockNumber();
    }
    const now = this.#now();
    const intent: LocalIntent = {
      id: `${ref}`,
      tabId: this.store.tabId,
      payer: identity.address,
      recipient,
      amount: amount.toString(),
      salt,
      ref,
      memo,
      phase: 'awaiting_approval',
      txHash: null,
      createdAt: now,
      createdHeight,
      updatedAt: now,
      message: null,
      serverIntentId: null,
    };
    saveIntents(this.store.tabId, [...this.intents, intent]);

    try {
      const server = await this.deps.api.createIntent({
        tabId: this.store.tabId,
        payer: identity.address,
        recipient,
        amount: intent.amount,
        ref,
        network: this.deps.network,
        idempotencyKey: intent.id,
      });
      this.#update(intent.id, { serverIntentId: server.id });
    } catch (e) {
      console.warn('[tally] could not register the payment intent with the server; continuing with the local record', e);
    }

    let txHash: string;
    try {
      ({ txHash } = await this.deps.wallet.sendNim({ recipient: toUserFriendly(recipient), luna: amount, memo }));
    } catch (e) {
      const err = e instanceof WalletError ? e : new WalletError('outcome_unknown', e instanceof Error ? e.message : 'The wallet did not answer.');
      if (err.kind === 'declined') return this.#update(intent.id, { phase: 'declined', message: 'You declined in Nimiq Pay. Nothing was sent.' });
      if (err.kind === 'rejected_before_prompt' || err.kind === 'unsupported' || err.kind === 'unavailable') {
        return this.#update(intent.id, { phase: 'rejected', message: `${err.message} Nothing was sent.` });
      }
      const unknown = this.#update(intent.id, {
        phase: 'unknown',
        message: 'Nimiq Pay did not confirm whether the payment went out. Tally is checking the network before anything else happens.',
      });
      const serverId = this.intents.find((x) => x.id === intent.id)?.serverIntentId;
      if (serverId) this.deps.api.markIntentUnknown(serverId).catch((er: unknown) => console.warn('[tally] mark unknown failed', er));
      return unknown;
    }

    return this.#recordSubmitted(identity, intent.id, txHash);
  }

  async #recordSubmitted(identity: Identity, intentId: string, txHash: string): Promise<LocalIntent> {
    const intent = this.#update(intentId, { phase: 'submitted', txHash, message: null });
    if (intent.serverIntentId) {
      this.deps.api.submitIntent(intent.serverIntentId, txHash).catch((e: unknown) => console.warn('[tally] submission sync failed', e));
    }
    if (!this.#claimFor(txHash)) {
      await this.store.append(identity, 'PAYMENT_RECORD', {
        recipient: intent.recipient,
        amount: intent.amount,
        txHash,
        salt: intent.salt,
        network: this.deps.network,
      });
    }
    return intent;
  }

  /**
   * Resolve an unknown outcome by looking for its memo on chain. Found: record
   * it. Past the validity window with nothing found: it can never land, so it is
   * safe to pay again. Otherwise it stays unknown, and no new payment starts.
   */
  async reconcile(identity: Identity, intentId: string): Promise<LocalIntent> {
    const intent = this.intents.find((x) => x.id === intentId);
    if (!intent || intent.phase !== 'unknown') throw new Error('Nothing to check for this payment.');
    const claimed = this.store.snapshot.state.payments.find((p) => p.ref === intent.ref && p.payer === intent.payer);
    if (claimed) return this.#recordSubmitted(identity, intent.id, claimed.txHash);

    const incoming = await this.deps.chain.incomingTransactions(toUserFriendly(intent.recipient), 100);
    const match = incoming.find((tx) => decodeMemo(tx.recipientData) === intent.memo);
    if (match) return this.#recordSubmitted(identity, intent.id, match.hash);

    const head = await this.deps.chain.headHeight();
    if (intent.createdHeight !== null && head > intent.createdHeight + VALIDITY_WINDOW_BLOCKS + EXPIRY_MARGIN_BLOCKS) {
      return this.#update(intent.id, {
        phase: 'expired',
        message: 'No payment with this reference reached the network, and it can no longer arrive. Nothing was sent; you can pay again.',
      });
    }
    return this.#update(intent.id, {
      message: 'No payment found yet. It could still arrive, so Tally will not start a new one. Check again in a minute.',
    });
  }

  /** Check every unresolved payment claim in the tab against the chain. */
  async verifyClaims(): Promise<{ checked: number; unavailable: boolean }> {
    const { state, verifications } = this.store.snapshot;
    if (!state.genesisHash) return { checked: 0, unavailable: false };
    const open = state.payments.filter((p) => {
      const v = verifications.get(p.txHash)?.status;
      return !v || !TERMINAL.has(v);
    });
    if (open.length === 0) return { checked: 0, unavailable: false };
    let head: number;
    try {
      head = await this.deps.chain.headHeight();
    } catch (e) {
      if (e instanceof ChainUnavailable) return { checked: 0, unavailable: true };
      throw e;
    }
    let checked = 0;
    for (const claim of open) {
      try {
        const tx = await this.deps.chain.transaction(claim.txHash);
        const v = verifyPaymentTransaction({ claim, genesisHash: state.genesisHash, tx, headHeight: head });
        this.store.setVerification(claim.txHash, {
          ...v,
          checkedAt: this.#now(),
          blockNumber: tx?.blockNumber ?? null,
          timestamp: tx?.timestamp ?? null,
        });
        checked += 1;
      } catch (e) {
        if (e instanceof ChainUnavailable) return { checked, unavailable: true };
        throw e;
      }
    }
    return { checked, unavailable: false };
  }
}
