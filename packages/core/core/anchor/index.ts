/**
 * Tally anchor commitments — PRD 3.3.
 *
 * The wire format `TLY1.<ledger8>.<round4>.<i>/<n>.<root27>` that rides in each
 * settlement transfer's data field — 50 bytes at the PRD's nominal single-digit
 * i/n, up to 54 bytes when i/n reach 999/999, always asserted <= 64 — the
 * canonical settlement
 * plan serialization, and the root hash chain
 * `root(r) = truncate160(Blake2b(root(r-1) || obligationLogRoot(r) || plan(r)))`.
 *
 * Encoding is exact and decoding is strict: malformed or non-canonical input
 * is rejected, never guessed at. Nothing here truncates silently.
 */
import { Hash } from '@nimiq/core';
import { bytesEqual, concatBytes, utf8 } from '../internal/bytes.js';
import type { SettlementPlan } from '../netting/index.js';

export const ANCHOR_MAX_BYTES = 64;

/** RFC 4648 base32, uppercase, no padding. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648 base64url, no padding. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface AnchorFields {
  /** First 5 bytes of the ledger genesis hash. */
  ledgerTag: Uint8Array;
  /** Round counter, 0 .. 2^20 - 1 (4 base32 chars = 20 bits). */
  round: number;
  /** 1-based transfer index within the round. */
  index: number;
  /** Total transfers in the round. */
  count: number;
  /** 160-bit truncated Blake2b round root. */
  root: Uint8Array;
}

export class AnchorFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorFormatError';
  }
}

function base32Encode5Bytes(bytes: Uint8Array): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let shift = 35n; shift >= 0n; shift -= 5n) {
    out += BASE32[Number((bits >> shift) & 31n)];
  }
  return out;
}

function base32Decode5Bytes(s: string): Uint8Array {
  let bits = 0n;
  for (const c of s) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new AnchorFormatError(`invalid base32 char "${c}"`);
    bits = (bits << 5n) | BigInt(v);
  }
  const out = new Uint8Array(5);
  for (let i = 4; i >= 0; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

function base32EncodeRound(round: number): string {
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
    out += BASE32[(round >> shift) & 31];
  }
  return out;
}

function base32DecodeRound(s: string): number {
  let value = 0;
  for (const c of s) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new AnchorFormatError(`invalid base32 char "${c}" in round`);
    value = value * 32 + v;
  }
  return value;
}

function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL[b0 >> 2];
    out += BASE64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += BASE64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += BASE64URL[b2 & 63];
  }
  return out;
}

function base64urlDecode27To20(s: string): Uint8Array {
  const values: number[] = [];
  for (const c of s) {
    const v = BASE64URL.indexOf(c);
    if (v < 0) throw new AnchorFormatError(`invalid base64url char "${c}" in root`);
    values.push(v);
  }
  let bits = 0n;
  for (const v of values) bits = (bits << 6n) | BigInt(v);
  // 27 chars carry 162 bits; the low 2 are padding and must be zero to be canonical.
  if ((bits & 3n) !== 0n) throw new AnchorFormatError('non-canonical base64url root (padding bits set)');
  bits >>= 2n;
  const out = new Uint8Array(20);
  for (let i = 19; i >= 0; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

export function ledgerTagFromGenesisHash(genesisHash: Uint8Array): Uint8Array {
  if (!(genesisHash instanceof Uint8Array) || genesisHash.length < 5) {
    throw new AnchorFormatError('genesis hash must be at least 5 bytes');
  }
  return genesisHash.slice(0, 5);
}

function assertInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new AnchorFormatError(`${what} must be an integer, got ${value}`);
}

export function encodeAnchor(fields: AnchorFields): string {
  const { ledgerTag, round, index, count, root } = fields;
  if (!(ledgerTag instanceof Uint8Array) || ledgerTag.length !== 5) {
    throw new AnchorFormatError('ledgerTag must be exactly 5 bytes');
  }
  assertInt(round, 'round');
  if (round < 0 || round >= 1 << 20) throw new AnchorFormatError(`round ${round} outside 20-bit range`);
  assertInt(index, 'index');
  assertInt(count, 'count');
  if (count < 1 || count > 999) throw new AnchorFormatError(`count ${count} outside 1..999`);
  if (index < 1 || index > count) throw new AnchorFormatError(`index ${index} outside 1..count(${count})`);
  if (!(root instanceof Uint8Array) || root.length !== 20) {
    throw new AnchorFormatError('root must be exactly 20 bytes (truncated Blake2b-160)');
  }

  const encoded = `TLY1.${base32Encode5Bytes(ledgerTag)}.${base32EncodeRound(round)}.${index}/${count}.${base64urlEncode(root)}`;
  const byteLength = utf8(encoded).length;
  if (byteLength > ANCHOR_MAX_BYTES) {
    throw new AnchorFormatError(`encoded anchor is ${byteLength} bytes, exceeds the ${ANCHOR_MAX_BYTES}-byte data field`);
  }
  return encoded;
}

const INDEX_RE = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/;

export function decodeAnchor(anchor: string): AnchorFields {
  if (typeof anchor !== 'string') throw new AnchorFormatError('anchor must be a string');
  if (utf8(anchor).length > ANCHOR_MAX_BYTES) {
    throw new AnchorFormatError(`anchor is ${utf8(anchor).length} bytes, exceeds ${ANCHOR_MAX_BYTES}`);
  }
  const parts = anchor.split('.');
  if (parts.length !== 5) throw new AnchorFormatError(`expected 5 dot-separated parts, got ${parts.length}`);
  const [magic, ledger8, round4, indexPart, root27] = parts as [string, string, string, string, string];
  if (magic !== 'TLY1') throw new AnchorFormatError(`bad magic "${magic}"`);
  if (ledger8.length !== 8) throw new AnchorFormatError(`ledger tag must be 8 base32 chars, got ${ledger8.length}`);
  if (round4.length !== 4) throw new AnchorFormatError(`round must be 4 base32 chars, got ${round4.length}`);
  const m = INDEX_RE.exec(indexPart);
  if (!m) throw new AnchorFormatError(`malformed index/count "${indexPart}"`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index > count) throw new AnchorFormatError(`index ${index} exceeds count ${count}`);
  if (root27.length !== 27) throw new AnchorFormatError(`root must be 27 base64url chars, got ${root27.length}`);
  const fields: AnchorFields = {
    ledgerTag: base32Decode5Bytes(ledger8),
    round: base32DecodeRound(round4),
    index,
    count,
    root: base64urlDecode27To20(root27),
  };
  const reEncoded = encodeAnchor(fields);
  if (reEncoded !== anchor) throw new AnchorFormatError('anchor is not in canonical form');
  return fields;
}

/**
 * Canonical settlement plan serialization — the exact bytes committed by the
 * round root. Text format, one line per element, '\n'-joined, no trailing
 * newline:
 *
 *   tally-plan-v1
 *   m:<mode>
 *   p:<address>:<position>     one per participant, address-sorted
 *   t:<from>:<to>:<amount>     one per transfer, plan order
 */
export function serializePlan(plan: SettlementPlan): Uint8Array {
  const members = new Set(plan.participants);
  for (let i = 1; i < plan.participants.length; i++) {
    if ((plan.participants[i - 1] as string) >= (plan.participants[i] as string)) {
      throw new AnchorFormatError('plan participants are not sorted — refusing to serialize a non-canonical plan');
    }
  }
  if (plan.positions.length !== plan.participants.length) {
    throw new AnchorFormatError('plan positions do not align with participants');
  }
  const lines = ['tally-plan-v1', `m:${plan.mode}`];
  for (let i = 0; i < plan.positions.length; i++) {
    const p = plan.positions[i] as SettlementPlan['positions'][number];
    if (p.address !== plan.participants[i]) {
      throw new AnchorFormatError('plan positions are not in participant order');
    }
    if (typeof p.position !== 'bigint') throw new AnchorFormatError('plan position must be a bigint');
    lines.push(`p:${p.address}:${p.position}`);
  }
  for (const t of plan.transfers) {
    if (!members.has(t.from) || !members.has(t.to)) {
      throw new AnchorFormatError('plan transfer references a non-participant');
    }
    if (typeof t.amount !== 'bigint' || t.amount <= 0n) {
      throw new AnchorFormatError('plan transfer amount must be a positive bigint');
    }
    lines.push(`t:${t.from}:${t.to}:${t.amount}`);
  }
  return utf8(lines.join('\n'));
}

/** root(0): 32 zero bytes, per PRD 3.3. */
export const GENESIS_ROOT: Uint8Array = new Uint8Array(32);

function isGenesisRoot(bytes: Uint8Array): boolean {
  return bytes.length === 32 && bytes.every((b) => b === 0);
}

/**
 * root(r) = truncate160(Blake2b(root(r-1) || obligationLogRoot(r) || serializePlan(plan(r))))
 *
 * `prevRoot` is GENESIS_ROOT (32 zero bytes) for the first round, and the
 * previous 20-byte round root afterwards. Anything else is rejected.
 */
export function computeRoundRoot(
  prevRoot: Uint8Array,
  obligationLogRoot: Uint8Array,
  plan: SettlementPlan,
): Uint8Array {
  if (!(prevRoot instanceof Uint8Array) || (prevRoot.length !== 20 && !isGenesisRoot(prevRoot))) {
    throw new AnchorFormatError('prevRoot must be a 20-byte round root or the 32-zero-byte genesis root');
  }
  if (!(obligationLogRoot instanceof Uint8Array) || obligationLogRoot.length !== 32) {
    throw new AnchorFormatError('obligationLogRoot must be 32 bytes');
  }
  const digest = Hash.computeBlake2b(concatBytes(prevRoot, obligationLogRoot, serializePlan(plan)));
  return digest.slice(0, 20);
}

export { bytesEqual };
