/**
 * Settlement over a replayed ledger: who owes whom right now, and whether a
 * chain transaction proves a payment.
 *
 * Accepted obligations are debts. A payment claim counts only once its
 * transaction is independently verified on chain, and then it enters netting as
 * a debt in the opposite direction. That single rule is what makes payment
 * safe against stale plans and double sends: whatever actually moved on chain
 * is credited at its real amount, so paying a stale amount, or paying twice,
 * leaves a visible credit instead of a hidden loss, and nothing is ever counted
 * paid on the strength of a hash or a relay's say-so.
 */
import { Address } from '@nimiq/core';
import { bytesToHex } from '../internal/bytes.js';
import { computePlan, type AddressHex, type Obligation, type SettlementPlan } from '../netting/index.js';
import { paymentMemo, type LedgerState, type PaymentClaim } from '../log/index.js';

export type ChainNetworkId = 5 | 24;

/**
 * A transaction as an independent chain source reports it. Field names follow
 * the Albatross JSON-RPC `getTransactionByHash` result.
 */
export interface ObservedTransaction {
  hash: string;
  /** User-friendly or hex address. */
  from: string;
  to: string;
  value: number | bigint;
  /** Hex of the recipient data field, possibly empty. */
  recipientData: string;
  networkId: number;
  blockNumber: number | null;
  /** False when the transaction was included but failed to execute. */
  executionResult: boolean | null;
}

export type VerificationStatus =
  /** Included, executed, matches the claim, and past the macro block that finalises it. */
  | 'confirmed'
  /** Included and matching, waiting for finality. */
  | 'observed'
  /** Not found on chain yet. */
  | 'pending'
  /** Found, but it does not prove this claim (wrong recipient, amount, network or memo). */
  | 'mismatch'
  /** Included but failed to execute. */
  | 'failed';

export interface Verification {
  status: VerificationStatus;
  reason: string | null;
}

/** Albatross batch length: finality lands at the next macro block. */
export const BLOCKS_PER_BATCH = 60;

export function toAddressHex(address: string): AddressHex {
  const trimmed = address.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  return bytesToHex(Address.fromUserFriendlyAddress(address).serialize());
}

export function toUserFriendly(addressHex: AddressHex): string {
  return Address.fromString(addressHex).toUserFriendlyAddress();
}

function decodeUtf8Hex(hex: string): string | null {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The macro block that finalises a transaction included at `blockNumber`. */
export function finalityHeight(blockNumber: number): number {
  return Math.ceil(blockNumber / BLOCKS_PER_BATCH) * BLOCKS_PER_BATCH;
}

/**
 * Does `tx` prove `claim`? Every field the claim asserts is checked against the
 * chain's own record. The memo must carry the claim's reference, which only the
 * claimant could have committed to, so nobody can claim another member's
 * payment as their own.
 */
export function verifyPaymentTransaction(input: {
  claim: Pick<PaymentClaim, 'recipient' | 'amount' | 'txHash' | 'ref' | 'network'>;
  genesisHash: string;
  tx: ObservedTransaction | null;
  headHeight: number;
}): Verification {
  const { claim, tx } = input;
  if (tx === null) return { status: 'pending', reason: 'not found on chain yet' };
  if (tx.hash.toLowerCase() !== claim.txHash) return { status: 'mismatch', reason: 'chain returned a different transaction' };
  if (tx.networkId !== claim.network) {
    return { status: 'mismatch', reason: `transaction is on network ${tx.networkId}, the claim says ${claim.network}` };
  }
  let recipient: AddressHex;
  try {
    recipient = toAddressHex(tx.to);
  } catch {
    return { status: 'mismatch', reason: 'transaction recipient is not a valid address' };
  }
  if (recipient !== claim.recipient) return { status: 'mismatch', reason: 'transaction paid a different recipient' };
  if (BigInt(tx.value) !== claim.amount) {
    return { status: 'mismatch', reason: `transaction moved ${tx.value} Luna, the claim says ${claim.amount}` };
  }
  const memo = decodeUtf8Hex(tx.recipientData ?? '');
  const expectedMemo = paymentMemo(input.genesisHash, claim.ref);
  if (memo !== expectedMemo) return { status: 'mismatch', reason: 'transaction memo does not carry this payment reference' };
  if (tx.blockNumber === null || tx.blockNumber <= 0) return { status: 'pending', reason: 'seen but not yet in a block' };
  if (tx.executionResult === false) return { status: 'failed', reason: 'transaction was included but failed to execute' };
  if (input.headHeight < finalityHeight(tx.blockNumber)) {
    return { status: 'observed', reason: 'included, waiting for the macro block that finalises it' };
  }
  return { status: 'confirmed', reason: null };
}

export interface PaymentView extends PaymentClaim {
  verification: Verification;
}

export interface SettlementView {
  /** Accepted, unpaid debts plus verified payments, as netting input. */
  edges: Obligation[];
  /** Pairwise debts still open before netting, after verified payments. */
  openDebtCount: number;
  /** The settlement plan over every active debt, or null when everyone is square. */
  plan: SettlementPlan | null;
  /** Net position per member: negative owes, positive is owed. Sums to zero. */
  positions: Map<AddressHex, bigint>;
  payments: PaymentView[];
}

/**
 * Netting input: every accepted obligation (including legacy round-consumed
 * ones) plus every confirmed payment as a reverse edge. Payments that are only
 * observed, pending, mismatched or failed move nothing.
 */
export function settlementView(
  state: LedgerState,
  verifications: ReadonlyMap<string, Verification>,
): SettlementView {
  const members = state.members.map((m) => m.address);
  const edges: Obligation[] = state.obligations
    .filter((o) => o.status === 'ACCEPTED' || o.status === 'IN_ROUND')
    .map((o) => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount }));

  const payments: PaymentView[] = state.payments.map((p) => ({
    ...p,
    verification: verifications.get(p.txHash) ?? { status: 'pending', reason: 'not checked yet' },
  }));
  for (const p of payments) {
    if (p.verification.status === 'confirmed') {
      edges.push({ debtor: p.recipient, creditor: p.payer, amount: p.amount });
    }
  }

  const positions = new Map<AddressHex, bigint>(members.map((m) => [m, 0n]));
  for (const e of edges) {
    positions.set(e.debtor, (positions.get(e.debtor) ?? 0n) - e.amount);
    positions.set(e.creditor, (positions.get(e.creditor) ?? 0n) + e.amount);
  }

  if (edges.length === 0 || members.length < 2) {
    return { edges, openDebtCount: 0, plan: null, positions, payments };
  }
  const plan = computePlan(members, edges, 'minimal');
  return {
    edges,
    openDebtCount: countPairwiseDebts(edges),
    plan: plan.transfers.length === 0 ? null : plan,
    positions,
    payments,
  };
}

/** Distinct who-owes-whom pairs once opposite debts between the same two people offset. */
export function countPairwiseDebts(edges: readonly Obligation[]): number {
  const net = new Map<string, bigint>();
  for (const e of edges) {
    const [a, b] = e.debtor < e.creditor ? [e.debtor, e.creditor] : [e.creditor, e.debtor];
    const sign = e.debtor === a ? 1n : -1n;
    const key = `${a}:${b}`;
    net.set(key, (net.get(key) ?? 0n) + sign * e.amount);
  }
  let count = 0;
  for (const v of net.values()) if (v !== 0n) count += 1;
  return count;
}
