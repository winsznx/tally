import { KeyPair, PrivateKey } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../internal/bytes.js';
import { createBindingAttestation, verifyBindingAttestation } from '../binding/index.js';
import {
  LogError,
  TallyLog,
  expenseShareId,
  paymentMemo,
  paymentRef,
  replayState,
  signEntry,
  validateEntry,
  type EntryType,
  type LogEntry,
} from '../log/index.js';
import {
  countPairwiseDebts,
  finalityHeight,
  settlementView,
  toAddressHex,
  toUserFriendly,
  verifyPaymentTransaction,
  type ObservedTransaction,
  type Verification,
} from './index.js';

interface Member {
  account: KeyPair;
  session: KeyPair;
}
const mk = (a: string, b: string): Member => ({
  account: KeyPair.derive(PrivateKey.fromHex(a.repeat(32))),
  session: KeyPair.derive(PrivateKey.fromHex(b.repeat(32))),
});
const ada = mk('a1', 'a2');
const bo = mk('b1', 'b2');
const cy = mk('c1', 'c2');
const dee = mk('d1', 'd2');
const addr = (m: Member): string => bytesToHex(m.account.toAddress().serialize());
const sessionPk = (m: Member): string => bytesToHex(m.session.publicKey.serialize());

let nonce = 0;
const nextNonce = (): string => (++nonce).toString(16).padStart(32, '0');

function entry(m: Member, entryType: EntryType, payload: Record<string, unknown>, log: TallyLog): LogEntry {
  let full = payload;
  if (entryType === 'LEDGER_OPEN' || entryType === 'MEMBER_JOIN') {
    const att = createBindingAttestation(m.account, sessionPk(m), 2);
    full = { ...payload, accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature };
  }
  const e = signEntry(
    {
      prevEntryHash: log.headHash,
      entryType,
      payload: full,
      authorAddress: addr(m),
      pursePublicKey: sessionPk(m),
      nonce: nextNonce(),
      logicalClock: entryType === 'LEDGER_OPEN' ? 0 : log.length,
    },
    m.session,
  );
  log.append(e);
  return e;
}

function tabWith(...members: Member[]): TallyLog {
  const log = new TallyLog();
  entry(members[0] as Member, 'LEDGER_OPEN', { name: 'Weekend', displayName: 'Ada' }, log);
  for (const m of members.slice(1)) entry(m, 'MEMBER_JOIN', { displayName: 'Friend' }, log);
  return log;
}

const sortShares = (shares: { member: string; amount: string }[]) =>
  [...shares].sort((a, b) => (a.member < b.member ? -1 : 1));

function propose(log: TallyLog, debtor: Member, creditor: Member, amount: bigint): string {
  const e = entry(creditor, 'OBLIGATION_PROPOSE', { debtor: addr(debtor), creditor: addr(creditor), amount: amount.toString() }, log);
  const id = replayState([...log.all()]).obligations.find((o) => o.createdClock === e.logicalClock)?.proposeId;
  return id as string;
}

function acceptAs(log: TallyLog, debtor: Member, proposeId: string): void {
  entry(debtor, 'OBLIGATION_ACCEPT', { proposeId, observedHeight: 100 }, log);
}

describe('v2 binding', () => {
  it('verifies a v2 attestation and still verifies v1', () => {
    expect(verifyBindingAttestation(createBindingAttestation(ada.account, sessionPk(ada), 2))).toBe(true);
    expect(verifyBindingAttestation(createBindingAttestation(ada.account, sessionPk(ada), 1))).toBe(true);
  });

  it('records display names from registration entries', () => {
    const st = replayState([...tabWith(ada, bo).all()]);
    expect(st.profiles.map((p) => p.displayName)).toEqual(
      st.profiles.map((p) => (p.address === addr(ada) ? 'Ada' : 'Friend')),
    );
  });
});

describe('EXPENSE_RECORD', () => {
  it('turns each non-payer share into a proposed obligation owed to the payer', () => {
    const log = tabWith(ada, bo, cy);
    const shares = sortShares([
      { member: addr(ada), amount: '100000' },
      { member: addr(bo), amount: '100000' },
      { member: addr(cy), amount: '100001' },
    ]);
    const e = entry(ada, 'EXPENSE_RECORD', { title: 'Dinner', total: '300001', method: 'equal', shares }, log);
    const st = replayState([...log.all()]);
    expect(st.expenses).toHaveLength(1);
    const owed = st.obligations.filter((o) => o.expenseId !== null);
    expect(owed).toHaveLength(2);
    expect(owed.every((o) => o.creditor === addr(ada) && o.status === 'PROPOSED')).toBe(true);
    const id = owed.find((o) => o.debtor === addr(cy))?.proposeId;
    expect(id).toBe(expenseShareId(st.expenses[0]?.expenseId as string, addr(cy)));
    expect(e.entryType).toBe('EXPENSE_RECORD');
    expect(st.acceptedPending).toHaveLength(0);
  });

  it('rejects shares that do not sum to the total', () => {
    const log = tabWith(ada, bo);
    const shares = sortShares([
      { member: addr(ada), amount: '1' },
      { member: addr(bo), amount: '1' },
    ]);
    expect(() => entry(ada, 'EXPENSE_RECORD', { title: 'x', total: '3', method: 'exact', shares }, log)).toThrow(LogError);
  });

  it('rejects unsorted or duplicate shares, and unknown split methods', () => {
    const log = tabWith(ada, bo);
    const unsorted = [...sortShares([{ member: addr(ada), amount: '1' }, { member: addr(bo), amount: '1' }])].reverse();
    expect(() => entry(ada, 'EXPENSE_RECORD', { title: 'x', total: '2', method: 'exact', shares: unsorted }, log)).toThrow(LogError);
    const shares = sortShares([{ member: addr(ada), amount: '1' }, { member: addr(bo), amount: '1' }]);
    expect(() => entry(ada, 'EXPENSE_RECORD', { title: 'x', total: '2', method: 'split', shares }, log)).toThrow(LogError);
  });

  it('skips an expense naming a non-member', () => {
    const log = tabWith(ada, bo);
    const shares = sortShares([{ member: addr(bo), amount: '5' }, { member: addr(dee), amount: '5' }]);
    entry(ada, 'EXPENSE_RECORD', { title: 'x', total: '10', method: 'exact', shares }, log);
    const st = replayState([...log.all()]);
    expect(st.expenses).toHaveLength(0);
    expect(st.ignored.at(-1)?.reason).toMatch(/not an active member/);
  });

  it('only the named debtor can accept a share', () => {
    const log = tabWith(ada, bo, cy);
    const shares = sortShares([{ member: addr(bo), amount: '7' }, { member: addr(cy), amount: '7' }]);
    entry(ada, 'EXPENSE_RECORD', { title: 'Taxi', total: '14', method: 'equal', shares }, log);
    const st0 = replayState([...log.all()]);
    const boShare = st0.obligations.find((o) => o.debtor === addr(bo))?.proposeId as string;
    acceptAs(log, cy, boShare);
    expect(replayState([...log.all()]).obligations.find((o) => o.proposeId === boShare)?.status).toBe('PROPOSED');
    acceptAs(log, bo, boShare);
    expect(replayState([...log.all()]).obligations.find((o) => o.proposeId === boShare)?.status).toBe('ACCEPTED');
  });
});

describe('OBLIGATION_CANCEL', () => {
  it('lets the creditor withdraw a request or forgive an accepted debt', () => {
    const log = tabWith(ada, bo);
    const id = propose(log, bo, ada, 50n);
    acceptAs(log, bo, id);
    entry(ada, 'OBLIGATION_CANCEL', { proposeId: id, reason: 'Paid in cash' }, log);
    const st = replayState([...log.all()]);
    expect(st.obligations[0]?.status).toBe('CANCELLED');
    expect(st.acceptedPending).toHaveLength(0);
  });

  it('refuses a cancel from the debtor', () => {
    const log = tabWith(ada, bo);
    const id = propose(log, bo, ada, 50n);
    acceptAs(log, bo, id);
    entry(bo, 'OBLIGATION_CANCEL', { proposeId: id }, log);
    const st = replayState([...log.all()]);
    expect(st.obligations[0]?.status).toBe('ACCEPTED');
    expect(st.ignored.at(-1)?.reason).toMatch(/only the creditor/);
  });

  it('does not let a cancelled obligation be accepted again', () => {
    const log = tabWith(ada, bo);
    const id = propose(log, bo, ada, 50n);
    entry(ada, 'OBLIGATION_CANCEL', { proposeId: id }, log);
    acceptAs(log, bo, id);
    expect(replayState([...log.all()]).obligations[0]?.status).toBe('CANCELLED');
  });
});

describe('payment references', () => {
  it('are bound to the payer so another member cannot claim them', () => {
    const salt = 'ab'.repeat(16);
    expect(paymentRef(addr(ada), salt)).not.toBe(paymentRef(addr(bo), salt));
    expect(paymentRef(addr(ada), salt)).toMatch(/^[a-z2-7]{16}$/);
  });

  it('fit comfortably in the 64-byte memo', () => {
    const memo = paymentMemo('ff'.repeat(32), paymentRef(addr(ada), '00'.repeat(16)));
    expect(new TextEncoder().encode(memo).length).toBe(30);
    expect(memo.startsWith('TLY2.')).toBe(true);
  });
});

describe('PAYMENT_RECORD', () => {
  const payment = (to: Member, amount: bigint, txHash: string, salt = '11'.repeat(16)) => ({
    recipient: addr(to),
    amount: amount.toString(),
    txHash,
    salt,
    network: 24,
  });

  it('records a claim, and a second claim on the same transaction is skipped', () => {
    const log = tabWith(ada, bo, cy);
    entry(bo, 'PAYMENT_RECORD', payment(ada, 10n, 'aa'.repeat(32)), log);
    entry(cy, 'PAYMENT_RECORD', payment(ada, 10n, 'aa'.repeat(32), '22'.repeat(16)), log);
    const st = replayState([...log.all()]);
    expect(st.payments).toHaveLength(1);
    expect(st.payments[0]?.payer).toBe(addr(bo));
    expect(st.ignored.at(-1)?.reason).toMatch(/already claimed/);
  });

  it('rejects malformed claims structurally', () => {
    const log = tabWith(ada, bo);
    expect(() => entry(bo, 'PAYMENT_RECORD', { ...payment(ada, 10n, 'aa'.repeat(32)), network: 1 }, log)).toThrow(LogError);
    expect(() => entry(bo, 'PAYMENT_RECORD', { ...payment(ada, 10n, 'xyz'), network: 24 }, log)).toThrow(LogError);
    expect(() => entry(bo, 'PAYMENT_RECORD', { ...payment(ada, 0n, 'aa'.repeat(32)) }, log)).toThrow(LogError);
  });

  it('cannot pay yourself', () => {
    const log = tabWith(ada, bo);
    entry(bo, 'PAYMENT_RECORD', payment(bo, 10n, 'aa'.repeat(32)), log);
    expect(replayState([...log.all()]).payments).toHaveLength(0);
  });
});

describe('settlementView', () => {
  /** The worked example Tally has always published: five debts, two transfers. */
  function fixture(): TallyLog {
    const log = tabWith(ada, bo, cy, dee);
    const edges: [Member, Member, bigint][] = [
      [ada, bo, 500n],
      [bo, cy, 500n],
      [cy, ada, 500n],
      [ada, dee, 1200n],
      [bo, dee, 300n],
    ];
    for (const [debtor, creditor, amount] of edges) acceptAs(log, debtor, propose(log, debtor, creditor, amount));
    return log;
  }

  it('reduces the five-debt example to two transfers with nothing for Cy', () => {
    const view = settlementView(replayState([...fixture().all()]), new Map());
    expect(view.openDebtCount).toBe(5);
    const legs = view.plan?.transfers.map((t) => [t.from, t.to, t.amount]);
    expect(legs).toHaveLength(2);
    expect(legs).toEqual(
      expect.arrayContaining([
        [addr(ada), addr(dee), 1200n],
        [addr(bo), addr(dee), 300n],
      ]),
    );
    expect(view.plan?.transfers.some((t) => t.from === addr(cy) || t.to === addr(cy))).toBe(false);
    expect([...view.positions.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it('ignores proposed and contested debts', () => {
    const log = tabWith(ada, bo);
    const id = propose(log, bo, ada, 50n);
    expect(settlementView(replayState([...log.all()]), new Map()).plan).toBeNull();
    entry(bo, 'OBLIGATION_REJECT', { proposeId: id }, log);
    expect(settlementView(replayState([...log.all()]), new Map()).plan).toBeNull();
  });

  it('credits a payment only once it is confirmed on chain', () => {
    const log = fixture();
    const hash = 'cd'.repeat(32);
    entry(ada, 'PAYMENT_RECORD', { recipient: addr(dee), amount: '1200', txHash: hash, salt: '33'.repeat(16), network: 24 }, log);
    const st = replayState([...log.all()]);
    const states: Verification['status'][] = ['pending', 'observed', 'mismatch', 'failed'];
    for (const status of states) {
      const view = settlementView(st, new Map([[hash, { status, reason: null }]]));
      expect(view.plan?.transfers).toHaveLength(2);
    }
    const settled = settlementView(st, new Map([[hash, { status: 'confirmed', reason: null }]]));
    expect(settled.plan?.transfers.map((t) => [t.from, t.to, t.amount])).toEqual([[addr(bo), addr(dee), 300n]]);
    expect(settled.positions.get(addr(ada))).toBe(0n);
  });

  it('turns a duplicate payment into a visible credit, never a lost one', () => {
    const log = tabWith(ada, bo);
    acceptAs(log, bo, propose(log, bo, ada, 100n));
    for (const [hash, salt] of [['01'.repeat(32), '44'.repeat(16)], ['02'.repeat(32), '55'.repeat(16)]] as const) {
      entry(bo, 'PAYMENT_RECORD', { recipient: addr(ada), amount: '100', txHash: hash, salt, network: 24 }, log);
    }
    const confirmed: Verification = { status: 'confirmed', reason: null };
    const view = settlementView(
      replayState([...log.all()]),
      new Map([
        ['01'.repeat(32), confirmed],
        ['02'.repeat(32), confirmed],
      ]),
    );
    expect(view.plan?.transfers.map((t) => [t.from, t.to, t.amount])).toEqual([[addr(ada), addr(bo), 100n]]);
  });

  it('counts opposite debts between two people as one', () => {
    expect(
      countPairwiseDebts([
        { debtor: addr(ada), creditor: addr(bo), amount: 5n },
        { debtor: addr(bo), creditor: addr(ada), amount: 2n },
        { debtor: addr(bo), creditor: addr(cy), amount: 1n },
      ]),
    ).toBe(2);
  });
});

describe('verifyPaymentTransaction', () => {
  const genesis = '0f'.repeat(32);
  const ref = paymentRef(addr(bo), '66'.repeat(16));
  const claim = { recipient: addr(ada), amount: 150000n, txHash: 'ee'.repeat(32), ref, network: 24 as const };
  const memoHex = bytesToHex(new TextEncoder().encode(paymentMemo(genesis, ref)));
  const good: ObservedTransaction = {
    hash: 'ee'.repeat(32),
    from: toUserFriendly(addr(cy)),
    to: toUserFriendly(addr(ada)),
    value: 150000,
    recipientData: memoHex,
    networkId: 24,
    blockNumber: 1000,
    executionResult: true,
  };
  const check = (tx: ObservedTransaction | null, headHeight = 2000) =>
    verifyPaymentTransaction({ claim, genesisHash: genesis, tx, headHeight }).status;

  it('confirms a matching, executed, finalised transaction', () => {
    expect(check(good)).toBe('confirmed');
  });
  it('waits for the macro block before confirming', () => {
    expect(finalityHeight(1000)).toBe(1020);
    expect(check(good, 1019)).toBe('observed');
    expect(check(good, 1020)).toBe('confirmed');
  });
  it('treats a missing or unmined transaction as pending', () => {
    expect(check(null)).toBe('pending');
    expect(check({ ...good, blockNumber: null })).toBe('pending');
  });
  it('rejects the wrong recipient, amount, network or memo', () => {
    expect(check({ ...good, to: toUserFriendly(addr(cy)) })).toBe('mismatch');
    expect(check({ ...good, value: 149999 })).toBe('mismatch');
    expect(check({ ...good, networkId: 5 })).toBe('mismatch');
    expect(check({ ...good, recipientData: '' })).toBe('mismatch');
    expect(check({ ...good, recipientData: 'ff' })).toBe('mismatch');
  });
  it('never confirms a transaction that failed to execute', () => {
    expect(check({ ...good, executionResult: false })).toBe('failed');
  });
  it('accepts hex and user-friendly addresses alike', () => {
    expect(toAddressHex(toUserFriendly(addr(ada)))).toBe(addr(ada));
    expect(check({ ...good, to: addr(ada) })).toBe('confirmed');
  });
});

describe('legacy compatibility', () => {
  it('still validates entries without the new optional fields', () => {
    const log = tabWith(ada, bo);
    for (const e of log.all()) expect(() => validateEntry(e)).not.toThrow();
  });
});
