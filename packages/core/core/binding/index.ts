/**
 * Purse-to-account binding attestation — PRD 3.1.
 *
 * A purse (session) key signs every log entry, which by itself proves only
 * that *some* key signed. The binding attestation is what proves *which Nimiq
 * Pay account* that purse speaks for — without it, every accountability claim
 * in Tally is hollow. It is required in BOTH purse mode and manual mode,
 * because Role 1 (log signing) exists in both.
 *
 * The account holder signs a domain-separated message naming the account and
 * the purse, using Nimiq Pay's `nimiq.sign()`. That call applies the Nimiq
 * Signed Message scheme (verified against core-rs-albatross
 * `wallet/src/wallet_account.rs`):
 *
 *   digest = sha256( "\x16Nimiq Signed Message:\n" + decimalByteLen(msg) + msg )
 *   signature = Ed25519_sign(accountKey, digest)      // signs the 32-byte digest
 *
 * Verification checks the signature against the account public key over that
 * digest, then confirms the account public key derives the claimed account
 * address. The message is reconstructed from the *entry's own* purse public
 * key, so a binding lifted from another context (naming a different purse) will
 * not verify — see the log's MEMBER_JOIN handling.
 */
import { Address, Hash, type KeyPair, PublicKey, Signature } from '@nimiq/core';
import { bytesToHex, concatBytes, hexToBytes, utf8 } from '../internal/bytes.js';
import type { AddressHex } from '../netting/index.js';

/** Fixed domain separator that opens the binding message (PRD 3.1). */
export const BINDING_MESSAGE_VERSION = 'Tally purse binding v1';

/** Nimiq's signed-message prefix. 0x16 is the length of "Nimiq Signed Message:\n". */
const NIMIQ_SIGNED_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Compressed encodings of the Ed25519 small-order (torsion) points — libsodium's
 * `has_small_order` table. @nimiq/core verifies with the COFACTORED equation, so
 * a public key that is one of these points makes the `h·A` term vanish and a
 * forged signature verifies over ANY message (the classic identity-key forgery).
 * A legitimate Nimiq account key is a scalar multiple of the base point and is
 * never a torsion point, so rejecting these rejects nothing real.
 */
const SMALL_ORDER_POINTS: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

/**
 * True if a 32-byte compressed point encoding is a small-order point. The sign
 * bit of the final byte is cleared before comparison so non-canonical encodings
 * collapse onto their canonical form, exactly as libsodium's has_small_order().
 */
function isSmallOrderPoint(pointHex: string): boolean {
  if (!HEX64.test(pointHex)) return true; // malformed → treat as unusable
  const lastByte = ((parseInt(pointHex.slice(62, 64), 16) & 0x7f) >>> 0).toString(16).padStart(2, '0');
  return SMALL_ORDER_POINTS.includes(pointHex.slice(0, 62) + lastByte);
}

export interface BindingAttestation {
  /** The Nimiq Pay account address, 40 lowercase hex (20 bytes). */
  accountAddress: AddressHex;
  /** The account's Ed25519 public key, 64 lowercase hex. Required to verify the signature. */
  accountPublicKey: string;
  /** The purse/session public key this account authorises, 64 lowercase hex. */
  pursePublicKey: string;
  /** The account's Nimiq-signed-message signature over the binding message, 128 lowercase hex. */
  bindingSignature: string;
}

/**
 * The exact binding message the account signs (PRD 3.1). Account rendered in
 * user-friendly IBAN form, purse as hex — reconstructed identically by signer
 * and verifier so the bytes always match.
 */
export function bindingMessage(accountAddress: AddressHex, pursePublicKey: string): string {
  const friendly = new Address(hexToBytes(accountAddress)).toUserFriendlyAddress();
  return `${BINDING_MESSAGE_VERSION}\naccount: ${friendly}\npurse: ${pursePublicKey}`;
}

/** The digest Nimiq Pay actually signs for a message (sha256 over prefix+len+msg). */
export function nimiqSignedMessageDigest(message: string): Uint8Array {
  const msg = utf8(message);
  const buffer = concatBytes(utf8(NIMIQ_SIGNED_MESSAGE_PREFIX), utf8(String(msg.length)), msg);
  return Hash.computeSha256(buffer);
}

/**
 * Verify a binding attestation. Returns true only when the account public key
 * signed `bindingMessage(accountAddress, pursePublicKey)` under the Nimiq
 * Signed Message scheme AND that public key derives `accountAddress`. Never
 * throws — malformed input returns false so replay can skip cleanly.
 */
export function verifyBindingAttestation(att: BindingAttestation): boolean {
  if (typeof att !== 'object' || att === null) return false;
  if (!HEX40.test(att.accountAddress)) return false;
  if (!HEX64.test(att.accountPublicKey)) return false;
  if (!HEX64.test(att.pursePublicKey)) return false;
  if (!HEX128.test(att.bindingSignature)) return false;
  // @nimiq/core's cofactored Ed25519 verify accepts a forged signature over any
  // message when the account key (or the signature's R) is a small-order point,
  // so reject those before verifying. Rejecting a zero s is cheap belt-and-braces.
  if (isSmallOrderPoint(att.accountPublicKey)) return false;
  if (isSmallOrderPoint(att.bindingSignature.slice(0, 64))) return false;
  if (att.bindingSignature.slice(64) === '0'.repeat(64)) return false;
  try {
    const accountPk = PublicKey.deserialize(hexToBytes(att.accountPublicKey));
    if (bytesToHex(accountPk.toAddress().serialize()) !== att.accountAddress) return false;
    const digest = nimiqSignedMessageDigest(bindingMessage(att.accountAddress, att.pursePublicKey));
    return accountPk.verify(Signature.deserialize(hexToBytes(att.bindingSignature)), digest);
  } catch {
    return false;
  }
}

/**
 * Reference/test producer of a valid attestation — signs the digest with the
 * account key exactly as Nimiq Pay's `nimiq.sign()` does. The real app never
 * holds the account key; it obtains the signature from the SDK and assembles
 * the attestation from that. Used by tests and to pin the exact byte scheme.
 */
export function createBindingAttestation(accountKeyPair: KeyPair, pursePublicKey: string): BindingAttestation {
  if (!HEX64.test(pursePublicKey)) throw new Error('pursePublicKey must be 64 lowercase hex chars');
  const accountAddress = bytesToHex(accountKeyPair.toAddress().serialize());
  const accountPublicKey = bytesToHex(accountKeyPair.publicKey.serialize());
  const digest = nimiqSignedMessageDigest(bindingMessage(accountAddress, pursePublicKey));
  const bindingSignature = bytesToHex(accountKeyPair.sign(digest).serialize());
  return { accountAddress, accountPublicKey, pursePublicKey, bindingSignature };
}
