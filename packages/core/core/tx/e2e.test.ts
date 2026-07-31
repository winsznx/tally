/**
 * Cross-module determinism: two devices holding the same log entries — in any
 * order — derive the same state, the same plan, the same round root, and
 * byte-identical settlement transactions. This is the whole product argument
 * (PRD 5.4) exercised end to end through all four modules.
 */
import { KeyPair, PrivateKey } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../internal/bytes.js';
import { GENESIS_ROOT, computeRoundRoot } from '../anchor/index.js';
import {
  TallyLog,
  entryId,
  obligationLogRoot,
  replayState,
  signEntry,
  type EntryType,
  type LedgerState,
  type LogEntry,
} from '../log/index.js';
import { computePlan, type Obligation } from '../netting/index.js';
import { TESTNET_NETWORK_ID, buildSettlementLeg, type SettlementLeg } from './index.js';

const alice = KeyPair.derive(PrivateKey.fromHex('a1'.repeat(32)));
const bob = KeyPair.derive(PrivateKey.fromHex('b2'.repeat(32)));
const carol = KeyPair.derive(PrivateKey.fromHex('c3'.repeat(32)));
const addr = (kp: KeyPair): string => bytesToHex(kp.toAddress().serialize());
const pk = (kp: KeyPair): string => bytesToHex(kp.publicKey.serialize());

let nonceCounter = 0x100;
function makeEntry(
  kp: KeyPair,
  entryType: EntryType,
  payload: Record<string, unknown>,
  prevEntryHash: string | null,
  logicalClock: number,
): LogEntry {
  nonceCounter += 1;
  return signEntry(
    {
      prevEntryHash,
      entryType,
      payload,
      authorAddress: addr(kp),
      pursePublicKey: pk(kp),
      nonce: nonceCounter.toString(16).padStart(32, '0'),
      logicalClock,
    },
    kp,
  );
}

function buildLedgerEntries(): LogEntry[] {
  const log = new TallyLog();
  log.append(makeEntry(alice, 'LEDGER_OPEN', { name: 'trip' }, null, 0));
  log.append(makeEntry(bob, 'MEMBER_JOIN', {}, log.headHash, 1));
  log.append(makeEntry(carol, 'MEMBER_JOIN', {}, log.headHash, 2));

  const p1 = makeEntry(
    alice,
    'OBLIGATION_PROPOSE',
    { debtor: addr(bob), creditor: addr(alice), amount: '120000' },
    log.headHash,
    3,
  );
  log.append(p1);
  const p2 = makeEntry(
    carol,
    'OBLIGATION_PROPOSE',
    { debtor: addr(bob), creditor: addr(carol), amount: '80000' },
    log.headHash,
    4,
  );
  log.append(p2);
  const p3 = makeEntry(
    alice,
    'OBLIGATION_PROPOSE',
    { debtor: addr(alice), creditor: addr(carol), amount: '30000' },
    log.headHash,
    5,
  );
  log.append(p3);

  log.append(makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId: entryId(p1) }, log.headHash, 6));
  log.append(makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId: entryId(p2) }, log.headHash, 7));
  log.append(makeEntry(alice, 'OBLIGATION_ACCEPT', { proposeId: entryId(p3) }, log.headHash, 8));

  log.append(makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 41_200, mode: 'minimal' }, log.headHash, 9));
  return [...log.all()];
}

/** What one device computes from an entry set: plan, root, and its own legs. */
function deviceComputation(entries: LogEntry[], device: KeyPair): {
  state: LedgerState;
  legs: SettlementLeg[];
} {
  const state = replayState(entries);
  const round = state.openRound;
  if (!round) throw new Error('expected an open round');

  const roundObligations: Obligation[] = state.obligations
    .filter((ob) => ob.round === round.round)
    .map((ob) => ({ debtor: ob.debtor, creditor: ob.creditor, amount: ob.amount }));
  const plan = computePlan(
    state.members.map((m) => m.address),
    roundObligations,
    round.mode,
  );
  const logRoot = obligationLogRoot(round.consumedAcceptIds);
  const roundRoot = computeRoundRoot(GENESIS_ROOT, logRoot, plan);

  const mine = addr(device);
  const legs: SettlementLeg[] = [];
  for (let i = 1; i <= plan.transfers.length; i++) {
    if (plan.transfers[i - 1]?.from !== mine) continue;
    legs.push(
      buildSettlementLeg({
        purse: device,
        plan,
        index: i,
        genesisHash: state.genesisHash as string,
        roundRoot,
        roundContext: { round: round.round, anchorHeight: round.anchorHeight },
        networkId: TESTNET_NETWORK_ID,
      }),
    );
  }
  return { state, legs };
}

describe('end-to-end: log → netting → anchor → tx', () => {
  it('two devices with the same entries in different orders build byte-identical legs', () => {
    const entries = buildLedgerEntries();
    const shuffledEntries = [...entries].reverse();

    const device1 = deviceComputation(entries, bob);
    const device2 = deviceComputation(shuffledEntries, bob);

    expect(device1.legs.length).toBeGreaterThan(0);
    expect(device1.legs.map((l) => l.hash)).toEqual(device2.legs.map((l) => l.hash));
    expect(device1.legs.map((l) => l.serializedHex)).toEqual(device2.legs.map((l) => l.serializedHex));
  });

  it('every leg uses the round anchor height, never any observed height', () => {
    const entries = buildLedgerEntries();
    const { legs } = deviceComputation(entries, bob);
    for (const leg of legs) {
      expect(leg.tx.validityStartHeight).toBe(41_200);
    }
  });

  it('each participant can build only their own legs', () => {
    const entries = buildLedgerEntries();
    const bobLegs = deviceComputation(entries, bob).legs;
    const carolLegs = deviceComputation(entries, carol).legs;
    for (const leg of bobLegs) expect(leg.transfer.from).toBe(addr(bob));
    for (const leg of carolLegs) expect(leg.transfer.from).toBe(addr(carol));
    const allFroms = new Set([...bobLegs, ...carolLegs].map((l) => l.transfer.from));
    expect(allFroms.has(addr(alice))).toBe(false);
  });
});
