import { KeyPair, PrivateKey } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../internal/bytes.js';
import { createBindingAttestation } from '../binding/index.js';
import {
  LogError,
  TallyLog,
  entryId,
  findDivergence,
  obligationLogRoot,
  replayState,
  signEntry,
  validateEntry,
  type EntryType,
  type LogEntry,
} from './index.js';

/**
 * A member has two keys: an account key (the Nimiq Pay wallet, identifies the
 * member and signs the binding) and a purse/session key (signs log entries).
 * authorAddress is the ACCOUNT address; the binding proves the purse speaks
 * for it.
 */
interface Member {
  account: KeyPair;
  purse: KeyPair;
}
const mk = (accountSeed: string, purseSeed: string): Member => ({
  account: KeyPair.derive(PrivateKey.fromHex(accountSeed.repeat(32))),
  purse: KeyPair.derive(PrivateKey.fromHex(purseSeed.repeat(32))),
});
const alice = mk('a1', 'a2');
const bob = mk('b1', 'b2');
const carol = mk('c1', 'c2');
const mallory = mk('e1', 'e2');

const addr = (m: Member): string => bytesToHex(m.account.toAddress().serialize());
const pursePk = (m: Member): string => bytesToHex(m.purse.publicKey.serialize());

let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(32, '0');
}

/** Builds an entry authored by m's account and signed by m's purse. Registration
 * entries (LEDGER_OPEN, MEMBER_JOIN) get a valid binding auto-injected. */
function makeEntry(
  m: Member,
  entryType: EntryType,
  payload: Record<string, unknown>,
  prevEntryHash: string | null,
  logicalClock: number,
  nonce: string = nextNonce(),
): LogEntry {
  let full = payload;
  if (entryType === 'LEDGER_OPEN' || entryType === 'MEMBER_JOIN') {
    const att = createBindingAttestation(m.account, pursePk(m));
    full = { ...payload, accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature };
  }
  return signEntry(
    { prevEntryHash, entryType, payload: full, authorAddress: addr(m), pursePublicKey: pursePk(m), nonce, logicalClock },
    m.purse,
  );
}

const stringify = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Ledger with alice + bob, one obligation bob→alice 500, proposed by alice. */
function basicLedger(): { log: TallyLog; proposeId: string } {
  const log = new TallyLog();
  const open = makeEntry(alice, 'LEDGER_OPEN', { name: 'flat 7' }, null, 0);
  log.append(open);
  log.append(makeEntry(bob, 'MEMBER_JOIN', {}, log.headHash, 1));
  const propose = makeEntry(
    alice,
    'OBLIGATION_PROPOSE',
    { debtor: addr(bob), creditor: addr(alice), amount: '500', memo: 'dinner' },
    log.headHash,
    2,
  );
  log.append(propose);
  return { log, proposeId: entryId(propose) };
}

describe('entry validation and signatures', () => {
  it('rejects a tampered payload', () => {
    const open = makeEntry(alice, 'LEDGER_OPEN', { name: 'x' }, null, 0);
    validateEntry(open);
    expect(() => validateEntry({ ...open, payload: { ...open.payload, name: 'y' } })).toThrow(LogError);
  });

  it('rejects an entry signed by a key other than its pursePublicKey', () => {
    const valid = makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId: '11'.repeat(32) }, 'aa'.repeat(32), 3);
    // signature was made by bob's purse; swapping the claimed purse key breaks it
    expect(() => validateEntry({ ...valid, pursePublicKey: pursePk(mallory) })).toThrow(LogError);
  });

  it('reserves clock 0 and null prev for LEDGER_OPEN', () => {
    expect(() => makeEntry(alice, 'MEMBER_JOIN', {}, null, 1)).toThrow(LogError);
    expect(() => makeEntry(alice, 'MEMBER_JOIN', {}, null, 0)).toThrow(LogError);
    expect(() => makeEntry(alice, 'LEDGER_OPEN', { name: 'x' }, null, 1)).toThrow(LogError);
  });

  it('rejects float amounts at the payload boundary', () => {
    const { log } = basicLedger();
    expect(() =>
      makeEntry(alice, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(alice), amount: '5.5' }, log.headHash, 3),
    ).toThrow(LogError);
    expect(() =>
      makeEntry(alice, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(alice), amount: 500 }, log.headHash, 3),
    ).toThrow(LogError);
  });

  it('rejects an obligation amount above MAX_LUNA at the payload boundary', () => {
    const { log } = basicLedger();
    expect(() =>
      makeEntry(alice, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(alice), amount: '9007199254740992' }, log.headHash, 3),
    ).toThrow(LogError);
  });
});

describe('silence is never consent', () => {
  it('a proposal with no matching accept never reaches the netting input, no matter how old', () => {
    const { log } = basicLedger();
    log.append(makeEntry(carol, 'MEMBER_JOIN', {}, log.headHash, 3));
    for (let clock = 4; clock < 30; clock++) {
      log.append(
        makeEntry(alice, 'OBLIGATION_PROPOSE', { debtor: addr(carol), creditor: addr(alice), amount: String(clock) }, log.headHash, clock),
      );
    }
    const state = log.replay();
    expect(state.acceptedPending).toEqual([]);
    expect(state.obligations.every((ob) => ob.status === 'PROPOSED')).toBe(true);
  });

  it('an accept authored by anyone but the named debtor is skipped and recorded', () => {
    const { log, proposeId } = basicLedger();
    log.append(makeEntry(carol, 'MEMBER_JOIN', {}, log.headHash, 3));
    log.append(makeEntry(alice, 'OBLIGATION_ACCEPT', { proposeId }, log.headHash, 4));
    log.append(makeEntry(carol, 'OBLIGATION_ACCEPT', { proposeId }, log.headHash, 5));
    const state = log.replay();
    expect(state.acceptedPending).toEqual([]);
    expect(state.ignored.map((i) => i.entryType)).toEqual(['OBLIGATION_ACCEPT', 'OBLIGATION_ACCEPT']);
    expect(state.ignored[0]?.reason).toContain('debtor');
  });

  it('only the debtor own accept moves an obligation into the netting input', () => {
    const { log, proposeId } = basicLedger();
    log.append(makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId }, log.headHash, 3));
    const state = log.replay();
    expect(state.acceptedPending).toEqual([
      { proposeId, debtor: addr(bob), creditor: addr(alice), amount: 500n },
    ]);
  });

  it('a rejected obligation is CONTESTED and excluded from netting', () => {
    const { log, proposeId } = basicLedger();
    log.append(makeEntry(bob, 'OBLIGATION_REJECT', { proposeId, reason: 'no' }, log.headHash, 3));
    const state = log.replay();
    expect(state.acceptedPending).toEqual([]);
    expect(state.obligations[0]?.status).toBe('CONTESTED');
  });
});

describe('order-independent replay', () => {
  it('any permutation of the same entry set yields identical state', () => {
    const { log, proposeId } = basicLedger();
    log.append(makeEntry(carol, 'MEMBER_JOIN', {}, log.headHash, 3));
    log.append(makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId }, log.headHash, 4));
    log.append(
      makeEntry(bob, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(carol), amount: '750' }, log.headHash, 5),
    );
    log.append(makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 41200, mode: 'minimal' }, log.headHash, 6));
    const entries = [...log.all()];
    const reference = stringify(replayState(entries));
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 20; i++) {
      expect(stringify(replayState(shuffled(entries, rand)))).toBe(reference);
    }
  });

  it('duplicate entries collapse by entry ID', () => {
    const { log } = basicLedger();
    const entries = [...log.all()];
    const doubled = [...entries, ...entries, entries[0] as LogEntry];
    expect(stringify(replayState(doubled))).toBe(stringify(replayState(entries)));
    const dup = log.append(entries[2] as LogEntry);
    expect(dup.duplicate).toBe(true);
    expect(log.length).toBe(3);
  });

  it('colliding entry IDs with different content resolve by content, not arrival order', () => {
    const { log } = basicLedger();
    const base = [...log.all()];
    const nonce = 'fe'.repeat(16);
    const payload = { debtor: addr(bob), creditor: addr(alice), amount: '77' };
    const early = makeEntry(alice, 'OBLIGATION_PROPOSE', payload, log.headHash, 3, nonce);
    const late = makeEntry(alice, 'OBLIGATION_PROPOSE', payload, log.headHash, 9, nonce);
    expect(entryId(early)).toBe(entryId(late));
    const accept = makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId: entryId(early) }, log.headHash, 5);

    const ab = stringify(replayState([...base, early, late, accept]));
    const ba = stringify(replayState([...base, late, early, accept]));
    expect(ab).toBe(ba);
  });

  it('same-clock entries order by entry ID, not arrival', () => {
    const { log } = basicLedger();
    log.append(
      makeEntry(alice, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(alice), amount: '10' }, log.headHash, 3),
    );
    log.append(
      makeEntry(bob, 'OBLIGATION_PROPOSE', { debtor: addr(alice), creditor: addr(bob), amount: '20' }, log.headHash, 3),
    );
    const entries = [...log.all()];
    expect(stringify(replayState(entries))).toBe(stringify(replayState([...entries].reverse())));
  });
});

describe('binding attestation at registration', () => {
  it('registers a member only when the join carries a valid binding', () => {
    const { log } = basicLedger();
    const state = log.replay();
    expect(state.members.map((m) => m.address).sort()).toEqual([addr(alice), addr(bob)].sort());
    // bob registered with bob's purse key, proven by bob's account binding
    const bobMember = state.members.find((m) => m.address === addr(bob));
    expect(bobMember?.pursePublicKey).toBe(pursePk(bob));
  });

  it('skips a MEMBER_JOIN whose binding was signed by the wrong account', () => {
    const log = new TallyLog();
    log.append(makeEntry(alice, 'LEDGER_OPEN', { name: 'x' }, null, 0));
    // Craft a join claiming bob's account + bob's purse, but sign the binding
    // with mallory's account key. authorAddress=bob so bob's purse signs the entry.
    const forgedBinding = createBindingAttestation(mallory.account, pursePk(bob));
    const join = signEntry(
      {
        prevEntryHash: log.headHash,
        entryType: 'MEMBER_JOIN',
        payload: { accountPublicKey: forgedBinding.accountPublicKey, bindingSignature: forgedBinding.bindingSignature },
        authorAddress: addr(bob),
        pursePublicKey: pursePk(bob),
        nonce: nextNonce(),
        logicalClock: 1,
      },
      bob.purse,
    );
    log.append(join);
    const state = log.replay();
    expect(state.members.map((m) => m.address)).toEqual([addr(alice)]);
    expect(state.ignored.some((i) => i.entryType === 'MEMBER_JOIN' && i.reason.includes('binding'))).toBe(true);
  });

  it('rejects a binding replayed from another ledger onto a different purse', () => {
    // A real binding alice made for HER purse, lifted into a join that an
    // attacker signs with a different purse. The binding names alice's purse,
    // but the entry's purse key is the attacker's, so verification fails.
    const log = new TallyLog();
    log.append(makeEntry(bob, 'LEDGER_OPEN', { name: 'other ledger' }, null, 0));
    const aliceRealBinding = createBindingAttestation(alice.account, pursePk(alice));
    const replayed = signEntry(
      {
        prevEntryHash: log.headHash,
        entryType: 'MEMBER_JOIN',
        payload: {
          accountPublicKey: aliceRealBinding.accountPublicKey,
          bindingSignature: aliceRealBinding.bindingSignature,
        },
        authorAddress: addr(alice),
        pursePublicKey: pursePk(mallory), // attacker's purse, not the one alice bound
        nonce: nextNonce(),
        logicalClock: 1,
      },
      mallory.purse,
    );
    log.append(replayed);
    const state = log.replay();
    expect(state.members.map((m) => m.address)).toEqual([addr(bob)]);
    expect(state.ignored.some((i) => i.reason.includes('binding'))).toBe(true);
  });
});

describe('membership and purse-key consistency', () => {
  it('skips entries whose purse key differs from the one registered at join', () => {
    const { log } = basicLedger();
    const impostor = signEntry(
      {
        prevEntryHash: log.headHash,
        entryType: 'OBLIGATION_PROPOSE',
        payload: { debtor: addr(alice), creditor: addr(bob), amount: '9999' },
        authorAddress: addr(bob),
        pursePublicKey: pursePk(mallory),
        nonce: nextNonce(),
        logicalClock: 3,
      },
      mallory.purse,
    );
    log.append(impostor);
    const state = log.replay();
    expect(state.obligations.map((o) => o.amount)).toEqual([500n]);
    expect(state.ignored.some((i) => i.reason.includes('purse key'))).toBe(true);
  });

  it('non-members cannot propose', () => {
    const { log } = basicLedger();
    log.append(
      makeEntry(mallory, 'OBLIGATION_PROPOSE', { debtor: addr(alice), creditor: addr(bob), amount: '1' }, log.headHash, 3),
    );
    const state = log.replay();
    expect(state.obligations).toHaveLength(1);
    expect(state.ignored.some((i) => i.reason.includes('not a member'))).toBe(true);
  });
});

describe('rounds', () => {
  function ledgerWithAccepted(): { log: TallyLog; proposeId: string; acceptId: string } {
    const { log, proposeId } = basicLedger();
    const accept = makeEntry(bob, 'OBLIGATION_ACCEPT', { proposeId }, log.headHash, 3);
    log.append(accept);
    return { log, proposeId, acceptId: entryId(accept) };
  }

  it('ROUND_OPEN consumes accepted obligations; ROUND_EXPIRE returns them', () => {
    const { log, acceptId } = ledgerWithAccepted();
    log.append(makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 41200, mode: 'minimal' }, log.headHash, 4));
    let state = log.replay();
    expect(state.acceptedPending).toEqual([]);
    expect(state.openRound).toMatchObject({ round: 1, anchorHeight: 41200, consumedAcceptIds: [acceptId] });
    expect(state.obligations[0]?.status).toBe('IN_ROUND');

    log.append(makeEntry(alice, 'ROUND_EXPIRE', { round: 1 }, log.headHash, 5));
    state = log.replay();
    expect(state.openRound).toBeNull();
    expect(state.lastClosedRound).toBe(1);
    expect(state.obligations[0]?.status).toBe('ACCEPTED');
    expect(state.acceptedPending).toHaveLength(1);
  });

  it('rejects forged ROUND_OPEN/ROUND_EXPIRE whose purse key is not the one registered at join', () => {
    const { log } = ledgerWithAccepted();
    // Mallory signs with her own key but claims alice's address as author.
    const forgedOpen = signEntry(
      {
        prevEntryHash: log.headHash,
        entryType: 'ROUND_OPEN',
        payload: { round: 1, anchorHeight: 999999, mode: 'minimal' },
        authorAddress: addr(alice),
        pursePublicKey: pursePk(mallory),
        nonce: nextNonce(),
        logicalClock: 4,
      },
      mallory.purse,
    );
    log.append(forgedOpen);
    let state = log.replay();
    expect(state.openRound).toBeNull();
    expect(state.ignored.some((i) => i.entryType === 'ROUND_OPEN' && i.reason.includes('purse key'))).toBe(true);

    // A legitimate open, then a forged expire attempt.
    log.append(makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 41200, mode: 'minimal' }, log.headHash, 5));
    const forgedExpire = signEntry(
      {
        prevEntryHash: log.headHash,
        entryType: 'ROUND_EXPIRE',
        payload: { round: 1 },
        authorAddress: addr(bob),
        pursePublicKey: pursePk(mallory),
        nonce: nextNonce(),
        logicalClock: 6,
      },
      mallory.purse,
    );
    log.append(forgedExpire);
    state = log.replay();
    expect(state.openRound?.round).toBe(1);
    expect(state.ignored.some((i) => i.entryType === 'ROUND_EXPIRE' && i.reason.includes('purse key'))).toBe(true);
  });

  it('rejects a ROUND_OPEN anchorHeight above the u32 ceiling at the payload boundary', () => {
    const { log } = ledgerWithAccepted();
    expect(() =>
      makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 0x1_0000_0000, mode: 'minimal' }, log.headHash, 4),
    ).toThrow(LogError);
  });

  it('rounds must open in sequence and never concurrently', () => {
    const { log } = ledgerWithAccepted();
    log.append(makeEntry(alice, 'ROUND_OPEN', { round: 5, anchorHeight: 100, mode: 'minimal' }, log.headHash, 4));
    log.append(makeEntry(alice, 'ROUND_OPEN', { round: 1, anchorHeight: 100, mode: 'minimal' }, log.headHash, 5));
    log.append(makeEntry(bob, 'ROUND_OPEN', { round: 2, anchorHeight: 200, mode: 'minimal' }, log.headHash, 6));
    const state = log.replay();
    expect(state.openRound?.round).toBe(1);
    expect(state.ignored.filter((i) => i.entryType === 'ROUND_OPEN')).toHaveLength(2);
  });
});

describe('head hash and fork detection', () => {
  it('identical histories produce identical head hashes', () => {
    const a = basicLedger().log;
    const b = new TallyLog();
    for (const e of a.all()) b.append(e);
    expect(b.headHash).toBe(a.headHash);
  });

  it('reports the divergence point of two forked logs', () => {
    const a = basicLedger().log;
    const b = new TallyLog();
    for (const e of a.all()) b.append(e);
    const ancestor = a.headHash;

    const onlyA = makeEntry(carol, 'MEMBER_JOIN', {}, a.headHash, 3, 'ab'.repeat(16));
    a.append(onlyA);
    const onlyB = makeEntry(bob, 'OBLIGATION_PROPOSE', { debtor: addr(bob), creditor: addr(alice), amount: '7' }, b.headHash, 3, 'ac'.repeat(16));
    b.append(onlyB);

    const d = findDivergence(a, b);
    expect(d.commonAncestor).toBe(ancestor);
    expect(d.localSuffix).toHaveLength(1);
    expect(d.remoteSuffix).toHaveLength(1);
    expect(d.localSuffix[0]).not.toBe(d.remoteSuffix[0]);
  });

  it('identical logs have empty suffixes; unrelated logs have no ancestor', () => {
    const a = basicLedger().log;
    const b = new TallyLog();
    for (const e of a.all()) b.append(e);
    expect(findDivergence(a, b)).toEqual({ commonAncestor: a.headHash, localSuffix: [], remoteSuffix: [] });

    const c = new TallyLog();
    c.append(makeEntry(carol, 'LEDGER_OPEN', { name: 'other' }, null, 0));
    expect(findDivergence(a, c).commonAncestor).toBeNull();
  });
});

describe('obligationLogRoot', () => {
  const id1 = '11'.repeat(32);
  const id2 = '22'.repeat(32);
  const id3 = '33'.repeat(32);

  it('is order-independent and set-sensitive', () => {
    const a = bytesToHex(obligationLogRoot([id1, id2, id3]));
    expect(bytesToHex(obligationLogRoot([id3, id1, id2]))).toBe(a);
    expect(bytesToHex(obligationLogRoot([id1, id2]))).not.toBe(a);
    expect(bytesToHex(obligationLogRoot([]))).toBe('00'.repeat(32));
  });

  it('rejects malformed IDs', () => {
    expect(() => obligationLogRoot(['xyz'])).toThrow(LogError);
  });
});
