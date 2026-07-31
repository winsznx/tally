/**
 * Entry signature verification for the relay — a SPAM FILTER, not a trust
 * anchor. Clients re-verify everything; the relay only rejects obviously forged
 * garbage so it does not store junk.
 *
 * Cloudflare Workers have no Blake2b, so the relay never recomputes core's entry
 * ids or hashes (those are content-addressed with Blake2b and supplied by the
 * client as opaque cursors). It only reconstructs the canonical signing TEXT —
 * pure string formatting, no hashing — and checks the Ed25519 signature with Web
 * Crypto. `entry.test.ts` cross-checks this signing text against @tally/core's
 * exported `entrySigningText`, so the two can never drift.
 */

export interface RawLogEntry {
  prevEntryHash: string | null;
  entryType: string;
  payload: Record<string, unknown>;
  authorAddress: string;
  pursePublicKey: string;
  purseSignature: string;
  nonce: string;
  logicalClock: number;
}

/** Canonical JSON — byte-identical to @tally/core's canonicalJson. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error('non-integer number in payload');
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`unserializable ${typeof value} in payload`);
  }
}

/** The exact text an entry's Ed25519 signature covers. */
export function entrySigningText(entry: RawLogEntry): string {
  return [
    'tally-log-entry-v1',
    `prev:${entry.prevEntryHash ?? '-'}`,
    `type:${entry.entryType}`,
    `author:${entry.authorAddress}`,
    `pursePk:${entry.pursePublicKey}`,
    `nonce:${entry.nonce}`,
    `clock:${entry.logicalClock}`,
    `payload:${canonicalJson(entry.payload)}`,
  ].join('\n');
}

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Structural shape check before any crypto — cheap rejection of garbage. */
export function isStructurallyValid(entry: RawLogEntry): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry.prevEntryHash === null || /^[0-9a-f]{64}$/.test(entry.prevEntryHash)) &&
    typeof entry.entryType === 'string' &&
    typeof entry.payload === 'object' &&
    entry.payload !== null &&
    /^[0-9a-f]{40}$/.test(entry.authorAddress) &&
    /^[0-9a-f]{64}$/.test(entry.pursePublicKey) &&
    /^[0-9a-f]{128}$/.test(entry.purseSignature) &&
    /^[0-9a-f]{32}$/.test(entry.nonce) &&
    Number.isSafeInteger(entry.logicalClock) &&
    entry.logicalClock >= 0
  );
}

/** Verify the entry's Ed25519 signature over its canonical signing text. */
export async function verifyEntrySignature(entry: RawLogEntry): Promise<boolean> {
  if (!isStructurallyValid(entry)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(entry.pursePublicKey), { name: 'Ed25519' }, false, [
      'verify',
    ]);
    const message = new TextEncoder().encode(entrySigningText(entry));
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(entry.purseSignature), message);
  } catch {
    return false;
  }
}
