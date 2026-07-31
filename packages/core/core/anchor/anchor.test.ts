import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computePlan, type Obligation } from '../netting/index.js';
import { bytesToHex, utf8 } from '../internal/bytes.js';
import {
  ANCHOR_MAX_BYTES,
  AnchorFormatError,
  GENESIS_ROOT,
  computeRoundRoot,
  decodeAnchor,
  encodeAnchor,
  ledgerTagFromGenesisHash,
  serializePlan,
} from './index.js';

const ada = '0a'.repeat(20);
const bo = '0b'.repeat(20);
const cy = '0c'.repeat(20);
const dee = '0d'.repeat(20);

const zeroTag = new Uint8Array(5);
const zeroRoot = new Uint8Array(20);

describe('anchor wire format', () => {
  it('encodes the all-zero anchor to the PRD example string at exactly 50 bytes', () => {
    const s = encodeAnchor({ ledgerTag: zeroTag, round: 0, index: 1, count: 1, root: zeroRoot });
    expect(s).toBe('TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(utf8(s).length).toBe(50);
  });

  it('round-trips arbitrary valid fields and never exceeds 64 bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 5, maxLength: 5 }),
        fc.nat((1 << 20) - 1),
        fc.nat(998),
        fc.nat(998),
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        (tag, round, a, b, root) => {
          const count = Math.max(a, b) + 1;
          const index = Math.min(a, b) + 1;
          const fields = { ledgerTag: tag, round, index, count, root };
          const s = encodeAnchor(fields);
          expect(utf8(s).length).toBeLessThanOrEqual(ANCHOR_MAX_BYTES);
          const back = decodeAnchor(s);
          expect(bytesToHex(back.ledgerTag)).toBe(bytesToHex(tag));
          expect(back.round).toBe(round);
          expect(back.index).toBe(index);
          expect(back.count).toBe(count);
          expect(bytesToHex(back.root)).toBe(bytesToHex(root));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('encode fails loudly on out-of-range fields instead of truncating', () => {
    const ok = { ledgerTag: zeroTag, round: 0, index: 1, count: 1, root: zeroRoot };
    expect(() => encodeAnchor({ ...ok, ledgerTag: new Uint8Array(4) })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, round: 1 << 20 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, round: -1 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, round: 1.5 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, index: 0 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, index: 2, count: 1 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, count: 1000 })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, root: new Uint8Array(19) })).toThrow(AnchorFormatError);
    expect(() => encodeAnchor({ ...ok, root: new Uint8Array(32) })).toThrow(AnchorFormatError);
  });

  it('decode rejects malformed input rather than guessing', () => {
    const good = 'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(decodeAnchor(good)).toBeTruthy();
    const bad = [
      'TLY2.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.aAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAA1.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.0/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.2/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.01/2.AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAB',
      'TLY1.AAAAAAAA.AAAA.1/1.AAAAAAAAAAAAAAAAAAAAAAAAAAA.x',
      '',
      'TLY1',
    ];
    for (const s of bad) {
      expect(() => decodeAnchor(s), JSON.stringify(s)).toThrow(AnchorFormatError);
    }
  });

  it('derives the ledger tag from the first 5 bytes of the genesis hash', () => {
    const genesis = new Uint8Array(32).map((_v, i) => i + 1);
    expect(bytesToHex(ledgerTagFromGenesisHash(genesis))).toBe('0102030405');
    expect(() => ledgerTagFromGenesisHash(new Uint8Array(4))).toThrow(AnchorFormatError);
  });
});

describe('canonical plan serialization', () => {
  const participants = [ada, bo, cy, dee];
  const obligations: Obligation[] = [
    { debtor: ada, creditor: bo, amount: 500n },
    { debtor: bo, creditor: cy, amount: 500n },
    { debtor: cy, creditor: ada, amount: 500n },
    { debtor: ada, creditor: dee, amount: 1200n },
    { debtor: bo, creditor: dee, amount: 300n },
  ];

  it('serializes the worked example to specified golden bytes', () => {
    const plan = computePlan(participants, obligations);
    const text = new TextDecoder().decode(serializePlan(plan));
    expect(text).toBe(
      [
        'tally-plan-v1',
        'm:minimal',
        `p:${ada}:-1200`,
        `p:${bo}:-300`,
        `p:${cy}:0`,
        `p:${dee}:1500`,
        `t:${ada}:${dee}:1200`,
        `t:${bo}:${dee}:300`,
      ].join('\n'),
    );
  });

  it('distinct plans produce distinct bytes', () => {
    const a = serializePlan(computePlan(participants, obligations));
    const tampered = obligations.map((o, i) => (i === 0 ? { ...o, amount: o.amount + 1n } : o));
    const b = serializePlan(computePlan(participants, tampered));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('refuses non-canonical hand-rolled plans', () => {
    const plan = computePlan(participants, obligations);
    const unsorted = { ...plan, participants: [...plan.participants].reverse(), positions: [...plan.positions].reverse() };
    expect(() => serializePlan(unsorted)).toThrow(AnchorFormatError);
  });
});

describe('root chain', () => {
  const participants = [ada, bo, cy, dee];
  const round1Obligations: Obligation[] = [
    { debtor: ada, creditor: dee, amount: 1200n },
    { debtor: bo, creditor: dee, amount: 300n },
  ];
  const round2Obligations: Obligation[] = [{ debtor: cy, creditor: ada, amount: 700n }];
  const round3Obligations: Obligation[] = [{ debtor: dee, creditor: bo, amount: 50n }];
  const logRoot1 = new Uint8Array(32).fill(1);
  const logRoot2 = new Uint8Array(32).fill(2);
  const logRoot3 = new Uint8Array(32).fill(3);

  function chain(obs1: Obligation[], lr1: Uint8Array): string[] {
    const r1 = computeRoundRoot(GENESIS_ROOT, lr1, computePlan(participants, obs1));
    const r2 = computeRoundRoot(r1, logRoot2, computePlan(participants, round2Obligations));
    const r3 = computeRoundRoot(r2, logRoot3, computePlan(participants, round3Obligations));
    return [r1, r2, r3].map(bytesToHex);
  }

  it('produces 20-byte roots and accepts only genesis or 20-byte prev roots', () => {
    const r1 = computeRoundRoot(GENESIS_ROOT, logRoot1, computePlan(participants, round1Obligations));
    expect(r1.length).toBe(20);
    expect(() => computeRoundRoot(new Uint8Array(32).fill(9), logRoot1, computePlan(participants, round1Obligations))).toThrow(AnchorFormatError);
    expect(() => computeRoundRoot(new Uint8Array(19), logRoot1, computePlan(participants, round1Obligations))).toThrow(AnchorFormatError);
    expect(() => computeRoundRoot(r1, new Uint8Array(31), computePlan(participants, round2Obligations))).toThrow(AnchorFormatError);
  });

  it('altering any single obligation in round 1 changes root(1) and every root after it', () => {
    const baseline = chain(round1Obligations, logRoot1);
    const tamperedObligations = round1Obligations.map((o, i) => (i === 0 ? { ...o, amount: o.amount + 1n } : o));
    const tamperedPlan = chain(tamperedObligations, logRoot1);
    const tamperedLog = chain(round1Obligations, new Uint8Array(32).fill(99));
    for (let r = 0; r < 3; r++) {
      expect(tamperedPlan[r], `plan tamper, root(${r + 1})`).not.toBe(baseline[r]);
      expect(tamperedLog[r], `log tamper, root(${r + 1})`).not.toBe(baseline[r]);
    }
  });

  it('is deterministic across calls', () => {
    expect(chain(round1Obligations, logRoot1)).toEqual(chain(round1Obligations, logRoot1));
  });
});
