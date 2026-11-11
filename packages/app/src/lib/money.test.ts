import { describe, expect, it } from 'vitest';
import { formatNim, lunaToSafeNumber, parseNim } from './money.js';
import { parsePercent, splitEqual, splitExact, splitPercent } from './split.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('parseNim', () => {
  it('parses exact Luna', () => {
    expect(parseNim('12.5')).toEqual({ ok: true, luna: 1_250_000n });
    expect(parseNim('0.00001')).toEqual({ ok: true, luna: 1n });
    expect(parseNim('.5')).toEqual({ ok: true, luna: 50_000n });
    expect(parseNim(' 1 000 ')).toEqual({ ok: true, luna: 100_000_000n });
  });
  it('refuses ambiguous, imprecise, empty, zero and negative input', () => {
    expect(parseNim('1,5')).toEqual({ ok: false, error: 'ambiguous' });
    expect(parseNim('0.000001')).toEqual({ ok: false, error: 'precision' });
    expect(parseNim('')).toEqual({ ok: false, error: 'empty' });
    expect(parseNim('0')).toEqual({ ok: false, error: 'zero' });
    expect(parseNim('-3')).toEqual({ ok: false, error: 'format' });
    expect(parseNim('1e5')).toEqual({ ok: false, error: 'format' });
    expect(parseNim('99999999999999999')).toEqual({ ok: false, error: 'too_large' });
  });
});

describe('formatNim', () => {
  it('formats exactly with grouping and trimmed decimals', () => {
    expect(formatNim(123_450_000n)).toBe('1,234.5');
    expect(formatNim(1n)).toBe('0.00001');
    expect(formatNim(-500_000n)).toBe('−5');
    expect(formatNim(500_000n, { signed: true })).toBe('+5');
    expect(formatNim(500_000n, { minDecimals: 2 })).toBe('5.00');
  });
  it('round-trips every parsed amount', () => {
    for (const s of ['1', '0.1', '12.34567', '1000000']) {
      const r = parseNim(s);
      expect(r.ok && formatNim(r.luna).replace(/,/g, '')).toBe(s);
    }
  });
});

describe('lunaToSafeNumber', () => {
  it('refuses values the SDK cannot carry exactly', () => {
    expect(lunaToSafeNumber(5n)).toBe(5);
    expect(() => lunaToSafeNumber(0n)).toThrow();
    expect(() => lunaToSafeNumber(2n ** 53n)).toThrow();
  });
});

describe('splits', () => {
  it('splits equally with visible, deterministic remainders', () => {
    const r = splitEqual(100_001n, [C, A, B]);
    expect(r.ok && r.shares).toEqual([
      { member: A, amount: 33_334n },
      { member: B, amount: 33_334n },
      { member: C, amount: 33_333n },
    ]);
    expect(r.ok && r.remainderNote).toMatch(/2 Luna/);
    const sum = r.ok ? r.shares.reduce((s, x) => s + x.amount, 0n) : 0n;
    expect(sum).toBe(100_001n);
  });
  it('refuses a split too small to share', () => {
    expect(splitEqual(2n, [A, B, C]).ok).toBe(false);
  });
  it('validates exact splits against the total', () => {
    expect(splitExact(10n, new Map([[A, 4n], [B, 6n]])).ok).toBe(true);
    expect(splitExact(10n, new Map([[A, 4n], [B, 5n]])).ok).toBe(false);
  });
  it('splits by percentage, conserving every Luna', () => {
    const r = splitPercent(100n, new Map([[A, 3333], [B, 3333], [C, 3334]]));
    expect(r.ok && r.shares.reduce((s, x) => s + x.amount, 0n)).toBe(100n);
    expect(splitPercent(100n, new Map([[A, 5000], [B, 4000]])).ok).toBe(false);
  });
  it('parses percentages to basis points', () => {
    expect(parsePercent('12.5')).toBe(1250);
    expect(parsePercent('100')).toBe(10_000);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('1.234')).toBeNull();
  });
});
