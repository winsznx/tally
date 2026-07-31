import { describe, expect, it } from 'vitest';
import { computePlan, netPositions, type Obligation } from './index.js';

const ada = '0a'.repeat(20);
const bo = '0b'.repeat(20);
const cy = '0c'.repeat(20);
const dee = '0d'.repeat(20);

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

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe('PRD 3.2 worked example', () => {
  const participants = [ada, bo, cy, dee];
  const obligations: Obligation[] = [
    { debtor: ada, creditor: bo, amount: 500n },
    { debtor: bo, creditor: cy, amount: 500n },
    { debtor: cy, creditor: ada, amount: 500n },
    { debtor: ada, creditor: dee, amount: 1200n },
    { debtor: bo, creditor: dee, amount: 300n },
  ];

  it('nets to Ada -1200, Bo -300, Cy 0, Dee +1500', () => {
    const plan = computePlan(participants, obligations);
    expect(plan.positions).toEqual([
      { address: ada, position: -1200n },
      { address: bo, position: -300n },
      { address: cy, position: 0n },
      { address: dee, position: 1500n },
    ]);
  });

  it('settles in exactly two transfers with Cy absent', () => {
    const plan = computePlan(participants, obligations);
    expect(plan.transfers).toEqual([
      { from: ada, to: dee, amount: 1200n },
      { from: bo, to: dee, amount: 300n },
    ]);
    for (const t of plan.transfers) {
      expect(t.from).not.toBe(cy);
      expect(t.to).not.toBe(cy);
    }
  });
});

describe('cycle cancellation', () => {
  it('cancels a three-way equal cycle to zero transfers, moving no money', () => {
    const obligations: Obligation[] = [
      { debtor: ada, creditor: bo, amount: 500n },
      { debtor: bo, creditor: cy, amount: 500n },
      { debtor: cy, creditor: ada, amount: 500n },
    ];
    for (const mode of ['minimal', 'pairwise'] as const) {
      const plan = computePlan([ada, bo, cy], obligations, mode);
      expect(plan.transfers).toEqual([]);
      for (const p of plan.positions) expect(p.position).toBe(0n);
    }
  });

  it('cancels only the cycle minimum from an unequal cycle', () => {
    const obligations: Obligation[] = [
      { debtor: ada, creditor: bo, amount: 800n },
      { debtor: bo, creditor: cy, amount: 500n },
      { debtor: cy, creditor: ada, amount: 300n },
    ];
    const plan = computePlan([ada, bo, cy], obligations, 'pairwise');
    expect(plan.transfers).toEqual([
      { from: ada, to: bo, amount: 500n },
      { from: bo, to: cy, amount: 200n },
    ]);
  });
});

describe('canonical ordering', () => {
  it('produces one identical plan for twenty shuffled input orders', () => {
    const participants = [ada, bo, cy, dee];
    const obligations: Obligation[] = [
      { debtor: ada, creditor: bo, amount: 500n },
      { debtor: bo, creditor: cy, amount: 500n },
      { debtor: cy, creditor: ada, amount: 500n },
      { debtor: ada, creditor: dee, amount: 1200n },
      { debtor: bo, creditor: dee, amount: 300n },
      { debtor: dee, creditor: cy, amount: 250n },
      { debtor: cy, creditor: bo, amount: 125n },
    ];
    const rand = mulberry32(0x7a11e7);
    const reference = stringify(computePlan(participants, obligations));
    for (let i = 0; i < 20; i++) {
      const plan = computePlan(shuffled(participants, rand), shuffled(obligations, rand));
      expect(stringify(plan)).toBe(reference);
    }
  });

  it('breaks equal-magnitude ties by address bytes, never insertion order', () => {
    const participants = [dee, cy, bo, ada];
    const obligations: Obligation[] = [
      { debtor: ada, creditor: dee, amount: 100n },
      { debtor: bo, creditor: cy, amount: 100n },
    ];
    const plan = computePlan(participants, obligations);
    expect(plan.transfers).toEqual([
      { from: ada, to: cy, amount: 100n },
      { from: bo, to: dee, amount: 100n },
    ]);
  });
});

describe('pairwise mode', () => {
  it('settles along real edges only, skipping greedy rerouting', () => {
    const obligations: Obligation[] = [
      { debtor: ada, creditor: bo, amount: 100n },
      { debtor: bo, creditor: cy, amount: 100n },
    ];
    const pairwise = computePlan([ada, bo, cy], obligations, 'pairwise');
    expect(pairwise.transfers).toEqual([
      { from: ada, to: bo, amount: 100n },
      { from: bo, to: cy, amount: 100n },
    ]);
    const minimal = computePlan([ada, bo, cy], obligations, 'minimal');
    expect(minimal.transfers).toEqual([{ from: ada, to: cy, amount: 100n }]);
  });
});

describe('input validation', () => {
  it('rejects non-bigint amounts before any arithmetic happens', () => {
    expect(() =>
      computePlan([ada, bo], [{ debtor: ada, creditor: bo, amount: 1.5 as unknown as bigint }]),
    ).toThrow(TypeError);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: bo, amount: 0n }])).toThrow(RangeError);
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: bo, amount: -5n }])).toThrow(RangeError);
  });

  it('rejects amounts above MAX_LUNA (2^53-1) that the settlement layer would wrap', () => {
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: bo, amount: 9007199254740992n }])).toThrow(RangeError);
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: bo, amount: 9007199254740991n }])).not.toThrow();
  });

  it('rejects self-obligations, unknown participants, duplicates, bad addresses', () => {
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: ada, amount: 1n }])).toThrow(RangeError);
    expect(() => computePlan([ada, bo], [{ debtor: ada, creditor: cy, amount: 1n }])).toThrow(RangeError);
    expect(() => computePlan([ada, ada], [])).toThrow(RangeError);
    expect(() => computePlan(['NQ07 0000'], [])).toThrow(TypeError);
    expect(() => computePlan([], [])).toThrow(RangeError);
  });

  it('accepts uppercase hex by normalizing, keeping order canonical', () => {
    const plan = computePlan([ada.toUpperCase(), bo], [{ debtor: ada.toUpperCase(), creditor: bo, amount: 7n }]);
    expect(plan.transfers).toEqual([{ from: ada, to: bo, amount: 7n }]);
  });
});

describe('netPositions', () => {
  it('matches plan positions in both modes', () => {
    const participants = [ada, bo, cy, dee];
    const obligations: Obligation[] = [
      { debtor: ada, creditor: dee, amount: 1200n },
      { debtor: bo, creditor: dee, amount: 300n },
      { debtor: dee, creditor: cy, amount: 90n },
    ];
    const positions = netPositions(participants, obligations);
    expect(computePlan(participants, obligations, 'minimal').positions).toEqual(positions);
    expect(computePlan(participants, obligations, 'pairwise').positions).toEqual(positions);
  });
});
