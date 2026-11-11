/**
 * Expense splits. Each method returns exact Luna shares that sum to the total,
 * sorted by member address, which is the order the signed EXPENSE_RECORD
 * requires. Indivisible Luna are handed out one at a time in address order, so
 * every device computes the same shares and the rounding is visible, never lost.
 */
export type SplitMethod = 'equal' | 'exact' | 'percent';

export interface Share {
  member: string;
  amount: bigint;
}

export type SplitResult =
  | { ok: true; shares: Share[]; remainderNote: string | null }
  | { ok: false; error: string };

const sortMembers = (members: readonly string[]): string[] => [...new Set(members)].sort();

export function splitEqual(total: bigint, members: readonly string[]): SplitResult {
  const sorted = sortMembers(members);
  if (sorted.length === 0) return { ok: false, error: 'Choose at least one person to split with.' };
  if (total <= 0n) return { ok: false, error: 'Enter an amount first.' };
  const n = BigInt(sorted.length);
  const base = total / n;
  const extra = Number(total % n);
  if (base === 0n) return { ok: false, error: 'The amount is too small to split between that many people.' };
  const shares = sorted.map((member, i) => ({ member, amount: base + (i < extra ? 1n : 0n) }));
  return {
    ok: true,
    shares,
    remainderNote: extra === 0 ? null : `${extra} Luna could not split evenly, so ${extra === 1 ? 'one person pays' : `${extra} people pay`} 1 Luna more.`,
  };
}

export function splitExact(total: bigint, amounts: ReadonlyMap<string, bigint>): SplitResult {
  const shares = sortMembers([...amounts.keys()])
    .map((member) => ({ member, amount: amounts.get(member) ?? 0n }))
    .filter((s) => s.amount > 0n);
  if (shares.length === 0) return { ok: false, error: 'Give at least one person an amount.' };
  const sum = shares.reduce((acc, s) => acc + s.amount, 0n);
  if (sum !== total) {
    return { ok: false, error: sum < total ? 'The amounts add up to less than the total.' : 'The amounts add up to more than the total.' };
  }
  return { ok: true, shares, remainderNote: null };
}

/**
 * Percentages in basis points (10,000 = 100%). Floors each share, then gives the
 * leftover Luna to the largest fractional parts, ties broken by address.
 */
export function splitPercent(total: bigint, basisPoints: ReadonlyMap<string, number>): SplitResult {
  const entries = sortMembers([...basisPoints.keys()])
    .map((member) => ({ member, bp: basisPoints.get(member) ?? 0 }))
    .filter((e) => e.bp > 0);
  if (entries.length === 0) return { ok: false, error: 'Give at least one person a percentage.' };
  if (entries.some((e) => !Number.isInteger(e.bp) || e.bp < 0)) return { ok: false, error: 'Use at most two decimal places for percentages.' };
  const sumBp = entries.reduce((acc, e) => acc + e.bp, 0);
  if (sumBp !== 10_000) return { ok: false, error: `The percentages add up to ${(sumBp / 100).toFixed(2)}%, not 100%.` };
  const raw = entries.map((e) => {
    const scaled = total * BigInt(e.bp);
    return { member: e.member, amount: scaled / 10_000n, frac: scaled % 10_000n };
  });
  let left = total - raw.reduce((acc, r) => acc + r.amount, 0n);
  const order = [...raw].sort((a, b) => (a.frac === b.frac ? (a.member < b.member ? -1 : 1) : a.frac > b.frac ? -1 : 1));
  for (const r of order) {
    if (left === 0n) break;
    r.amount += 1n;
    left -= 1n;
  }
  const shares = raw.filter((r) => r.amount > 0n).map(({ member, amount }) => ({ member, amount }));
  const distributed = raw.filter((r) => r.frac > 0n).length;
  return {
    ok: true,
    shares,
    remainderNote: distributed === 0 ? null : 'Some shares were rounded to whole Luna; the extra Luna went to the largest remainders.',
  };
}

/** "12.5" or "12" percent text to basis points, or null when it is not a valid percentage. */
export function parsePercent(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bp <= 10_000 ? bp : null;
}
