import { KeyPair, PrivateKey } from '@nimiq/core';
import { createBindingAttestation } from '@tally/core/binding';
import {
  TallyLog,
  derivedAnchorHeight,
  deterministicNonce,
  entryId,
  signEntry,
  type EntryType,
  type LogEntry,
} from '@tally/core/log';
import { describe, expect, it } from 'vitest';
import { deriveViewModel, ingestEntries, type ObservedLeg } from './ledger-state.js';

interface Member {
  account: KeyPair;
  purse: KeyPair;
}
const mk = (a: string, p: string): Member => ({
  account: KeyPair.derive(PrivateKey.fromHex(a.repeat(32))),
  purse: KeyPair.derive(PrivateKey.fromHex(p.repeat(32))),
});
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const addr = (m: Member): string => hex(m.account.toAddress().serialize());
const pursePk = (m: Member): string => hex(m.purse.publicKey.serialize());

const ada = mk('a1', 'a2');
const bo = mk('b1', 'b2');
const cy = mk('c1', 'c2');
const dee = mk('d1', 'd2');

let nonce = 0;
function make(m: Member, type: EntryType, payload: Record<string, unknown>, prev: string | null, clock: number): LogEntry {
  let full = payload;
  if (type === 'LEDGER_OPEN' || type === 'MEMBER_JOIN') {
    const att = createBindingAttestation(m.account, pursePk(m));
    full = { ...payload, accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature };
  }
  nonce += 1;
  return signEntry(
    { prevEntryHash: prev, entryType: type, payload: full, authorAddress: addr(m), pursePublicKey: pursePk(m), nonce: nonce.toString(16).padStart(32, '0'), logicalClock: clock },
    m.purse,
  );
}

/** The PRD 3.2 worked example as a real signed log: Ada/Bo/Cy/Dee, 5 obligations. */
function workedExampleLog(): TallyLog {
  const log = new TallyLog();
  log.append(make(ada, 'LEDGER_OPEN', { name: 'trip' }, null, 0));
  log.append(make(bo, 'MEMBER_JOIN', {}, log.headHash, 1));
  log.append(make(cy, 'MEMBER_JOIN', {}, log.headHash, 2));
  log.append(make(dee, 'MEMBER_JOIN', {}, log.headHash, 3));

  const obligations: [Member, Member, string][] = [
    [ada, bo, '500'],
    [bo, cy, '500'],
    [cy, ada, '500'],
    [ada, dee, '1200'],
    [bo, dee, '300'],
  ];
  let clock = 4;
  for (const [debtor, creditor, amount] of obligations) {
    const p = make(creditor, 'OBLIGATION_PROPOSE', { debtor: addr(debtor), creditor: addr(creditor), amount }, log.headHash, clock++);
    log.append(p);
    log.append(make(debtor, 'OBLIGATION_ACCEPT', { proposeId: entryId(p), observedHeight: 41200 }, log.headHash, clock++));
  }
  return log;
}

describe('ingestEntries re-verifies (untrusted relay/cache)', () => {
  it('keeps valid entries and drops garbage and tampered ones', () => {
    const log = workedExampleLog();
    const raws = log.all().map((e) => JSON.stringify(e));
    expect(ingestEntries(raws).length).toBe(log.length);

    const tampered = { ...(log.all()[0] as LogEntry), payload: { name: 'evil' } };
    expect(ingestEntries([JSON.stringify(tampered)]).length).toBe(0);
    expect(ingestEntries(['{not json', '{}']).length).toBe(0);
  });
});

describe('deriveViewModel', () => {
  it('derives net positions and the Ada/Bo/Cy/Dee settlement preview (2 transfers, Cy absent)', () => {
    const entries = [...workedExampleLog().all()];
    const vm = deriveViewModel({ entries, myAddress: addr(dee), headHeight: 41300, nowMs: 0 });

    const pos = new Map(vm.members.map((m) => [m.address, m.position]));
    expect(pos.get(addr(ada))).toBe(-1200n);
    expect(pos.get(addr(bo))).toBe(-300n);
    expect(pos.get(addr(cy))).toBe(0n);
    expect(pos.get(addr(dee))).toBe(1500n);
    expect(vm.myPosition).toBe(1500n);

    expect(vm.preview?.transfers).toEqual([
      { from: addr(ada), to: addr(dee), amount: 1200n },
      { from: addr(bo), to: addr(dee), amount: 300n },
    ]);
    // Cy nets to zero → absent from the plan
    expect(vm.preview?.transfers.some((t) => t.from === addr(cy) || t.to === addr(cy))).toBe(false);
  });

  it('surfaces requests awaiting me vs awaiting others', () => {
    const log = new TallyLog();
    log.append(make(ada, 'LEDGER_OPEN', { name: 'flat' }, null, 0));
    log.append(make(bo, 'MEMBER_JOIN', {}, log.headHash, 1));
    // ada proposes bo owes ada — a request awaiting bo
    log.append(make(ada, 'OBLIGATION_PROPOSE', { debtor: addr(bo), creditor: addr(ada), amount: '500' }, log.headHash, 2));

    const asBo = deriveViewModel({ entries: [...log.all()], myAddress: addr(bo), headHeight: null, nowMs: 0 });
    expect(asBo.requestsForMe.length).toBe(1);
    expect(asBo.awaitingOthers.length).toBe(0);

    const asAda = deriveViewModel({ entries: [...log.all()], myAddress: addr(ada), headHeight: null, nowMs: 0 });
    expect(asAda.requestsForMe.length).toBe(0);
    expect(asAda.awaitingOthers.length).toBe(1);
  });

  it('GAP 2: a partial round shows per-leg status and an expiry countdown', () => {
    const log = workedExampleLog();
    const consumed = log.replay().obligations.filter((o) => o.status === 'ACCEPTED');
    const anchor = derivedAnchorHeight(consumed);
    const roundPayload = { round: 1, anchorHeight: anchor, mode: 'minimal' as const };
    log.append(
      signEntry(
        {
          prevEntryHash: log.headHash,
          entryType: 'ROUND_OPEN',
          payload: roundPayload,
          authorAddress: addr(ada),
          pursePublicKey: pursePk(ada),
          nonce: deterministicNonce('ROUND_OPEN', roundPayload),
          logicalClock: 20,
        },
        ada.purse,
      ),
    );

    // Ada's 1,200 leg landed and confirmed; Bo's 300 leg not yet broadcast.
    const observedLegs: ObservedLeg[] = [
      { from: addr(ada), to: addr(dee), amount: 1200n, txHash: 'aa', confirmed: true },
    ];
    const vm = deriveViewModel({ entries: [...log.all()], myAddress: addr(dee), headHeight: anchor + 100, nowMs: 0, observedLegs });

    expect(vm.openRound).not.toBeNull();
    const r = vm.openRound!;
    expect(r.landedCount).toBe(1);
    expect(r.totalCount).toBe(2);
    const boLeg = r.legs.find((l) => l.from === addr(bo));
    expect(boLeg?.status).toBe('waiting');
    expect(boLeg?.waitingOn).toBe(addr(bo)); // "waiting on Bo", never a bare spinner
    expect(r.expired).toBe(false);
    expect(r.expiresInSeconds).toBe((anchor + 7200 - (anchor + 100)) * 1);
  });

  it('marks waiting legs expired once the validity window passes', () => {
    const log = workedExampleLog();
    const consumed = log.replay().obligations.filter((o) => o.status === 'ACCEPTED');
    const anchor = derivedAnchorHeight(consumed);
    const roundPayload = { round: 1, anchorHeight: anchor, mode: 'minimal' as const };
    log.append(
      signEntry(
        { prevEntryHash: log.headHash, entryType: 'ROUND_OPEN', payload: roundPayload, authorAddress: addr(ada), pursePublicKey: pursePk(ada), nonce: deterministicNonce('ROUND_OPEN', roundPayload), logicalClock: 20 },
        ada.purse,
      ),
    );
    const vm = deriveViewModel({ entries: [...log.all()], myAddress: addr(dee), headHeight: anchor + 7300, nowMs: 0 });
    expect(vm.openRound?.expired).toBe(true);
    expect(vm.openRound?.legs.every((l) => l.status === 'expired')).toBe(true);
  });
});
