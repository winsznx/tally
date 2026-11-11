/**
 * Everything a screen shows about a tab, derived from one replay. Balances are
 * never stored separately, so two screens can never disagree.
 */
import { entryHash, entryId, type ExpenseRecord, type LogEntry, type ObligationRecord, type PaymentClaim } from '@tally/core/log';
import type { Transfer } from '@tally/core/netting';
import type { VerificationStatus } from '@tally/core/settle';
import { shortAddress } from './identity.js';
import type { TabSnapshot } from './tab.js';

export interface Person {
  address: string;
  name: string;
  isMe: boolean;
  active: boolean;
}

export interface MySummary {
  /** Negative: you owe overall. Positive: you are owed. */
  position: bigint;
  /** Requests waiting for you to accept or decline. */
  toReview: ObligationRecord[];
  /** Your requests waiting on someone else. */
  waitingOnOthers: ObligationRecord[];
  contested: ObligationRecord[];
  /** Plan legs you pay. */
  legsOut: Transfer[];
  /** Plan legs paid to you. */
  legsIn: Transfer[];
  /** Your payments still being checked on chain. */
  paymentsChecking: PaymentClaim[];
}

export type ActivityKind = 'tab' | 'member' | 'expense' | 'request' | 'accept' | 'decline' | 'cancel' | 'payment' | 'round';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: number | null;
  pending: boolean;
  text: string;
  detail: string | null;
  amount: bigint | null;
  link: string | null;
  status: 'neutral' | 'agreed' | 'waiting' | 'declined' | 'paid' | 'checking' | 'problem';
}

export function people(snapshot: TabSnapshot, me: string | null): Map<string, Person> {
  const names = new Map(snapshot.state.profiles.map((p) => [p.address, p.displayName]));
  const map = new Map<string, Person>();
  for (const m of snapshot.state.members) {
    const chosen = names.get(m.address);
    map.set(m.address, {
      address: m.address,
      name: chosen ?? shortAddress(m.address),
      isMe: m.address === me,
      active: m.active,
    });
  }
  return map;
}

export function nameOf(map: Map<string, Person>, address: string, opts: { you?: boolean } = {}): string {
  const p = map.get(address);
  if (!p) return shortAddress(address);
  if (p.isMe && opts.you !== false) return 'You';
  return p.name;
}

const TERMINAL: ReadonlySet<VerificationStatus> = new Set(['confirmed', 'failed', 'mismatch']);

export function mySummary(snapshot: TabSnapshot, me: string): MySummary {
  const { state, settlement, verifications } = snapshot;
  const transfers = settlement.plan?.transfers ?? [];
  return {
    position: settlement.positions.get(me) ?? 0n,
    toReview: state.obligations.filter((o) => o.status === 'PROPOSED' && o.debtor === me),
    waitingOnOthers: state.obligations.filter((o) => o.status === 'PROPOSED' && o.creditor === me),
    contested: state.obligations.filter((o) => o.status === 'CONTESTED' && (o.creditor === me || o.debtor === me)),
    legsOut: transfers.filter((t) => t.from === me),
    legsIn: transfers.filter((t) => t.to === me),
    paymentsChecking: state.payments.filter((p) => {
      const v = verifications.get(p.txHash)?.status;
      return p.payer === me && (!v || !TERMINAL.has(v));
    }),
  };
}

export function expenseById(snapshot: TabSnapshot, expenseId: string): ExpenseRecord | null {
  return snapshot.state.expenses.find((e) => e.expenseId === expenseId) ?? null;
}

export function obligationsOfExpense(snapshot: TabSnapshot, expenseId: string): ObligationRecord[] {
  return snapshot.state.obligations.filter((o) => o.expenseId === expenseId);
}

export function paymentStatusLabel(status: VerificationStatus | undefined): ActivityItem['status'] {
  if (status === 'confirmed') return 'paid';
  if (status === 'failed' || status === 'mismatch') return 'problem';
  return 'checking';
}

/** Newest first. Reads like a group chat summary, not a log dump. */
export function activity(snapshot: TabSnapshot, me: string | null, tabId: string): ActivityItem[] {
  const who = people(snapshot, me);
  const n = (a: string): string => nameOf(who, a);
  const pendingHashes = new Set(snapshot.pending.map(entryHash));
  const byPropose = new Map(snapshot.state.obligations.map((o) => [o.proposeId, o]));
  const expenseIds = new Set(snapshot.state.expenses.map((e) => e.expenseId));
  const ignored = new Set(snapshot.state.ignored.map((i) => i.id));
  const items: ActivityItem[] = [];

  for (const e of snapshot.entries) {
    const id = entryId(e);
    if (ignored.has(id)) continue;
    const hash = entryHash(e);
    const base = { id: hash, at: snapshot.receivedAt.get(hash) ?? null, pending: pendingHashes.has(hash), detail: null, amount: null, link: null };
    const author = n(e.authorAddress);
    const p = e.payload;
    const item = describe(e, p, author, base, { byPropose, expenseIds, n, tabId, snapshot });
    if (item) items.push(item);
  }
  return items.reverse();
}

function describe(
  e: LogEntry,
  p: Record<string, unknown>,
  author: string,
  base: Pick<ActivityItem, 'id' | 'at' | 'pending' | 'detail' | 'amount' | 'link'>,
  ctx: {
    byPropose: Map<string, ObligationRecord>;
    expenseIds: Set<string>;
    n: (a: string) => string;
    tabId: string;
    snapshot: TabSnapshot;
  },
): ActivityItem | null {
  const ob = typeof p['proposeId'] === 'string' ? ctx.byPropose.get(p['proposeId']) : undefined;
  const obLink = ob?.expenseId ? `/app/tabs/${ctx.tabId}/expenses/${ob.expenseId}` : null;
  switch (e.entryType) {
    case 'LEDGER_OPEN':
      return { ...base, kind: 'tab', status: 'neutral', text: `${author} started the tab “${String(p['name'])}”` };
    case 'MEMBER_JOIN':
      return { ...base, kind: 'member', status: 'neutral', text: `${author} joined` };
    case 'MEMBER_LEAVE':
      return { ...base, kind: 'member', status: 'neutral', text: `${author} left the tab` };
    case 'EXPENSE_RECORD': {
      const id = entryId(e);
      if (!ctx.expenseIds.has(id)) return null;
      return {
        ...base,
        kind: 'expense',
        status: 'neutral',
        text: `${author} paid for ${String(p['title'])}`,
        amount: BigInt(String(p['total'])),
        link: `/app/tabs/${ctx.tabId}/expenses/${id}`,
      };
    }
    case 'OBLIGATION_PROPOSE':
      return {
        ...base,
        kind: 'request',
        status: 'waiting',
        text: `${author} asked ${ctx.n(String(p['debtor']))} for ${String(p['memo'] ?? 'a share')}`,
        amount: BigInt(String(p['amount'])),
      };
    case 'OBLIGATION_ACCEPT':
      return {
        ...base,
        kind: 'accept',
        status: 'agreed',
        text: ob ? `${author} agreed to owe ${ctx.n(ob.creditor)} for ${ob.memo ?? 'a share'}` : `${author} agreed to a share`,
        amount: ob?.amount ?? null,
        link: obLink,
      };
    case 'OBLIGATION_REJECT':
      return {
        ...base,
        kind: 'decline',
        status: 'declined',
        text: ob ? `${author} declined ${ob.memo ?? 'a share'}` : `${author} declined a share`,
        detail: typeof p['reason'] === 'string' ? `“${p['reason']}”` : null,
        amount: ob?.amount ?? null,
        link: obLink,
      };
    case 'OBLIGATION_CANCEL':
      return {
        ...base,
        kind: 'cancel',
        status: 'neutral',
        text: ob ? `${author} withdrew ${ctx.n(ob.debtor)}’s share of ${ob.memo ?? 'an expense'}` : `${author} withdrew a share`,
        detail: typeof p['reason'] === 'string' ? `“${p['reason']}”` : null,
        amount: ob?.amount ?? null,
        link: obLink,
      };
    case 'PAYMENT_RECORD': {
      const txHash = String(p['txHash']);
      const v = ctx.snapshot.verifications.get(txHash)?.status;
      const status = paymentStatusLabel(v);
      const verb = status === 'paid' ? 'paid' : status === 'problem' ? 'reported a payment to' : 'sent a payment to';
      return {
        ...base,
        kind: 'payment',
        status,
        text: `${author} ${verb} ${ctx.n(String(p['recipient']))}`,
        detail: status === 'paid' ? 'Confirmed on Nimiq' : status === 'problem' ? 'Not confirmed: the network record does not match' : 'Checking the network',
        amount: BigInt(String(p['amount'])),
        link: `/app/tabs/${ctx.tabId}/payments/${txHash}`,
      };
    }
    case 'ROUND_OPEN':
    case 'ROUND_EXPIRE':
      return { ...base, kind: 'round', status: 'neutral', text: `${author} updated a settlement round from an earlier version of Tally` };
  }
}
