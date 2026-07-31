/**
 * The app's single source of truth transform. The log is truth; this module
 * replays it into state and derives everything the UI shows. Nothing is stored
 * twice — obligations, balances, round status, and the settlement plan are all
 * DERIVED here from the entries and the chain, never kept as separate mutable
 * state that could drift.
 */
import { PublicKey } from '@nimiq/core';
import {
  computePlan,
  type Obligation,
  type SettlementPlan,
  type Transfer,
} from '@tally/core/netting';
import {
  replayState,
  validateEntry,
  type LedgerState,
  type LogEntry,
  type ObligationRecord,
} from '@tally/core/log';

/** The purse address a member pays from (their MEMBER_JOIN publishes the key). */
function purseAddressOf(pursePublicKeyHex: string): string {
  const bytes = new Uint8Array(pursePublicKeyHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(pursePublicKeyHex.slice(i * 2, i * 2 + 2), 16);
  return Array.from(PublicKey.deserialize(bytes).toAddress().serialize(), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** The 7,200-block validity window is ~2 hours; a round dies when it passes. */
export const VALIDITY_WINDOW_BLOCKS = 7200;
const SECONDS_PER_BLOCK = 1;

export type LegStatus = 'landed' | 'sending' | 'waiting' | 'expired';

export interface LegView {
  from: string;
  to: string;
  amount: bigint;
  status: LegStatus;
  /** Present when the leg is waiting on a specific debtor to open the app. */
  waitingOn: string | null;
  txHash: string | null;
}

export interface RoundView {
  round: number;
  anchorHeight: number;
  mode: 'minimal' | 'pairwise';
  legs: LegView[];
  landedCount: number;
  totalCount: number;
  /** Seconds until the validity window expires, from the shared clock. */
  expiresInSeconds: number | null;
  expired: boolean;
}

export interface MemberView {
  address: string;
  /** Negative = owes, positive = is owed, 0 = settled. */
  position: bigint;
}

export interface LedgerViewModel {
  name: string | null;
  genesisHash: string | null;
  members: MemberView[];
  /** My net position across accepted obligations, or null if I am not a member. */
  myPosition: bigint | null;
  /** Obligations proposed to me, awaiting my accept/reject. */
  requestsForMe: ObligationRecord[];
  /** Obligations I proposed that are still awaiting the debtor. */
  awaitingOthers: ObligationRecord[];
  /** The settlement preview if a round opened now (deterministic). */
  preview: SettlementPlan | null;
  openRound: RoundView | null;
  /** Entries that failed contextual checks (surfaced for debugging/transparency). */
  ignoredCount: number;
}

/** A settlement transfer observed on-chain, matched to a round by its anchor. */
export interface ObservedLeg {
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  confirmed: boolean;
}

export interface DeriveInput {
  entries: LogEntry[];
  myAddress: string | null;
  headHeight: number | null;
  nowMs: number;
  /** Legs seen on-chain for the open round, keyed however the caller matched them. */
  observedLegs?: ObservedLeg[];
}

/**
 * Re-verify raw entries and drop anything that does not validate. This is the
 * client-side re-verification that makes the relay and the cache untrusted:
 * every entry's signature and structure is checked here before it reaches state.
 */
export function ingestEntries(rawEntryJsons: string[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const raw of rawEntryJsons) {
    let entry: LogEntry;
    try {
      entry = JSON.parse(raw) as LogEntry;
      validateEntry(entry); // signature + structure; throws on bad
    } catch {
      continue; // untrusted source produced garbage — skip it
    }
    const key = `${entry.authorAddress}:${entry.nonce}:${entry.entryType}:${JSON.stringify(entry.payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function toObligations(records: ObligationRecord[]): Obligation[] {
  return records.map((r) => ({ debtor: r.debtor, creditor: r.creditor, amount: r.amount }));
}

/** The full view model for a ledger, derived from entries + chain observations. */
export function deriveViewModel(input: DeriveInput): LedgerViewModel {
  const state: LedgerState = replayState(input.entries);
  const memberAddrs = state.members.map((m) => m.address);

  let preview: SettlementPlan | null = null;
  if (state.acceptedPending.length > 0) {
    preview = computePlan(memberAddrs, toObligations(state.acceptedPending as unknown as ObligationRecord[]), 'minimal');
  }

  // Positions must include obligations an open round has already consumed —
  // otherwise the hero reads "0 NIM · settled up" the moment a round opens,
  // while the money is still owed and has not moved.
  const owedNow = [
    ...state.acceptedPending,
    ...state.obligations.filter((o) => o.status === 'IN_ROUND'),
  ];
  const positions = positionsForMembers(memberAddrs, owedNow);
  const myPosition = input.myAddress && positions.has(input.myAddress) ? (positions.get(input.myAddress) as bigint) : null;

  const requestsForMe = state.obligations.filter((o) => o.status === 'PROPOSED' && o.debtor === input.myAddress);
  const awaitingOthers = state.obligations.filter((o) => o.status === 'PROPOSED' && o.creditor === input.myAddress);

  return {
    name: state.ledgerName,
    genesisHash: state.genesisHash,
    members: memberAddrs.map((address) => ({ address, position: positions.get(address) ?? 0n })),
    myPosition,
    requestsForMe,
    awaitingOthers,
    preview,
    openRound: state.openRound
      ? deriveRoundView(state, input)
      : null,
    ignoredCount: state.ignored.length,
  };
}

function positionsForMembers(
  members: string[],
  accepted: readonly { debtor: string; creditor: string; amount: bigint }[],
): Map<string, bigint> {
  const pos = new Map<string, bigint>();
  for (const m of members) pos.set(m, 0n);
  for (const ob of accepted) {
    pos.set(ob.debtor, (pos.get(ob.debtor) ?? 0n) - ob.amount);
    pos.set(ob.creditor, (pos.get(ob.creditor) ?? 0n) + ob.amount);
  }
  return pos;
}

/**
 * GAP 2: a partial round is a normal state, not a spinner. Each leg is shown per
 * counterparty as landed / sending / waiting-on-a-named-person, with the round's
 * expiry as a countdown. A round's legs come from the settlement plan over the
 * consumed obligations; their status comes from matching on-chain observations.
 */
function deriveRoundView(state: LedgerState, input: DeriveInput): RoundView {
  const round = state.openRound!;
  const inRound = state.obligations.filter((o) => o.round === round.round);
  // The round's pinned participant set, so the legs shown are the legs committed.
  const plan = computePlan(round.participants, toObligations(inRound), round.mode);

  const observed = input.observedLegs ?? [];
  // A leg is paid FROM the payer's purse in purse mode and from their ACCOUNT in
  // manual mode, so an on-chain settlement matches a plan leg on either address.
  const purseByAccount = new Map(state.members.map((m) => [m.address, purseAddressOf(m.pursePublicKey)]));
  const legs: LegView[] = plan.transfers.map((t: Transfer) => {
    const payerPurse = purseByAccount.get(t.from);
    const match = observed.find(
      (o) => (o.from === t.from || o.from === payerPurse) && o.to === t.to && o.amount === t.amount,
    );
    let status: LegStatus;
    if (match) status = match.confirmed ? 'landed' : 'sending';
    else status = 'waiting';
    return {
      from: t.from,
      to: t.to,
      amount: t.amount,
      status,
      waitingOn: status === 'waiting' ? t.from : null,
      txHash: match?.txHash ?? null,
    };
  });

  const expiryHeight = round.anchorHeight + VALIDITY_WINDOW_BLOCKS;
  const blocksLeft = input.headHeight === null ? null : expiryHeight - input.headHeight;
  const expired = blocksLeft !== null && blocksLeft <= 0;
  const expiresInSeconds = blocksLeft === null ? null : Math.max(0, blocksLeft * SECONDS_PER_BLOCK);

  return {
    round: round.round,
    anchorHeight: round.anchorHeight,
    mode: round.mode,
    legs: legs.map((l) => (expired && l.status === 'waiting' ? { ...l, status: 'expired' as const } : l)),
    landedCount: legs.filter((l) => l.status === 'landed').length,
    totalCount: legs.length,
    expiresInSeconds,
    expired,
  };
}
