/**
 * NIM amounts. Everything is Luna as bigint (100,000 Luna = 1 NIM); a float
 * never touches an amount. Parsing is strict on purpose: a pasted "1,5" could
 * mean one and a half or fifteen, so ambiguous input is refused, not guessed.
 */
import { MAX_LUNA } from '@tally/core/netting';

export const LUNA_PER_NIM = 100_000n;
export const NIM_DECIMALS = 5;

export type ParseError = 'empty' | 'format' | 'ambiguous' | 'precision' | 'zero' | 'too_large';

export type ParseResult = { ok: true; luna: bigint } | { ok: false; error: ParseError };

const PLAIN = /^(\d+)(?:\.(\d*))?$/;
const LEADING_DOT = /^\.(\d+)$/;

export function parseNim(input: string): ParseResult {
  const s = input.trim().replace(/[\s  ]/g, '');
  if (s === '') return { ok: false, error: 'empty' };
  if (s.includes(',')) return { ok: false, error: 'ambiguous' };
  const leading = LEADING_DOT.exec(s);
  const m = leading ? ['', '0', leading[1]] : PLAIN.exec(s);
  if (!m) return { ok: false, error: 'format' };
  const whole = m[1] as string;
  const frac = (m[2] ?? '') as string;
  if (frac.length > NIM_DECIMALS) return { ok: false, error: 'precision' };
  if (whole.length > 16) return { ok: false, error: 'too_large' };
  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(frac.padEnd(NIM_DECIMALS, '0') || '0');
  if (luna === 0n) return { ok: false, error: 'zero' };
  if (luna > MAX_LUNA) return { ok: false, error: 'too_large' };
  return { ok: true, luna };
}

export const PARSE_ERROR_COPY: Record<ParseError, string> = {
  empty: 'Enter an amount.',
  format: 'Use digits and one decimal point, like 12.5.',
  ambiguous: 'Use a dot for decimals, like 12.5. Commas are ambiguous.',
  precision: 'NIM has at most 5 decimal places.',
  zero: 'The amount has to be more than zero.',
  too_large: 'That amount is larger than any NIM payment can carry.',
};

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatOptions {
  /** Always show this many decimals (0..5). Default: trim trailing zeros, keep at least 0. */
  minDecimals?: number;
  /** Prefix positive numbers with "+". */
  signed?: boolean;
}

/** "1,234.5" for 123450000n. Exact: every Luna is representable, nothing rounds. */
export function formatNim(luna: bigint, opts: FormatOptions = {}): string {
  const negative = luna < 0n;
  const abs = negative ? -luna : luna;
  const whole = abs / LUNA_PER_NIM;
  let frac = (abs % LUNA_PER_NIM).toString().padStart(NIM_DECIMALS, '0').replace(/0+$/, '');
  const min = Math.max(0, Math.min(NIM_DECIMALS, opts.minDecimals ?? 0));
  if (frac.length < min) frac = frac.padEnd(min, '0');
  const body = groupThousands(whole.toString()) + (frac ? `.${frac}` : '');
  if (negative) return `−${body}`;
  return opts.signed && luna > 0n ? `+${body}` : body;
}

/** Luna to the number the SDK expects. Refuses anything that would lose precision. */
export function lunaToSafeNumber(luna: bigint): number {
  if (luna <= 0n || luna > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`amount ${luna} cannot be passed to the wallet exactly`);
  }
  return Number(luna);
}
