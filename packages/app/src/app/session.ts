/**
 * Session — identity and entry authoring.
 *
 * A member has two keys (see SECURITY.md):
 *   account key — the Nimiq Pay wallet. Signs the binding attestation. Never
 *                 held by this app; we only ever get signatures from the SDK.
 *   purse key   — generated here, on the device. Signs every log entry (Role 1,
 *                 present in every mode) and, once funded, pays settlements
 *                 with no dialog (Role 2, purse mode only).
 *
 * ## Why the purse is generated, not derived — a documented PRD deviation
 *
 * PRD 3.1 makes derivation primary: `seed = H(domain, bindingSignature)`. But
 * the attestation that proves *which account* a purse speaks for must name the
 * purse public key inside the signed message, and you cannot name a key you
 * have not derived yet. Doing both needs TWO account signatures — binding
 * derivation plus attestation — which makes setup three dialogs, contradicting
 * the PRD's own "exactly two dialogs" promise (3.1, 4.2). The derivation
 * signature also cannot be published: its hash IS the purse seed.
 *
 * So we take the PRD's own documented fallback (3.1, "Fallback if determinism
 * fails testing"): generate the purse randomly, attest it with ONE account
 * signature, and make cross-device recovery work by encrypting the purse key
 * with a key derived from that same signature. Setup stays at two dialogs
 * (attest, fund), accountability is unchanged, and nothing depends on
 * `nimiq.sign()` being deterministic — which the device gate has not yet
 * confirmed. If Test 1 shows determinism holds, the encrypted-blob recovery
 * path can be swapped for derivation without touching anything above this file.
 */
import { KeyPair, PrivateKey } from '@nimiq/core';
import { bindingMessage, createBindingAttestation, type BindingAttestation } from '@tally/core/binding';
import {
  deterministicNonce,
  entryHash,
  entryId,
  signEntry,
  type EntryType,
  type LogEntry,
} from '@tally/core/log';
import type { ProviderAdapter, ProviderResult } from '../adapters/types.js';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Entry types whose content must collapse across devices rather than merely not fork. */
const DETERMINISTIC_ENTRIES: ReadonlySet<EntryType> = new Set(['ROUND_OPEN', 'ROUND_EXPIRE']);

export interface Identity {
  /** Nimiq Pay account address, 40 hex. Recovered from a signed tx or attestation. */
  accountAddress: string;
  /** The purse key that signs log entries. */
  purse: KeyPair;
  /** Proof that `accountAddress` authorised this purse. Published in MEMBER_JOIN. */
  attestation: BindingAttestation;
}

export interface StoredIdentity {
  accountAddress: string;
  pursePrivateKeyHex: string;
  attestation: BindingAttestation;
}

export function serializeIdentity(id: Identity): StoredIdentity {
  return {
    accountAddress: id.accountAddress,
    pursePrivateKeyHex: id.purse.privateKey.toHex(),
    attestation: id.attestation,
  };
}

export function restoreIdentity(stored: StoredIdentity): Identity {
  return {
    accountAddress: stored.accountAddress,
    purse: KeyPair.derive(PrivateKey.fromHex(stored.pursePrivateKeyHex)),
    attestation: stored.attestation,
  };
}

/**
 * Create an identity: generate a purse, then ask the wallet to attest it. This
 * is dialog 1 of 2. A declined dialog returns `declined` — a normal outcome the
 * UI shows as a state, never an error.
 */
export async function bindPurse(
  provider: ProviderAdapter,
  accountAddress: string,
): Promise<ProviderResult<Identity>> {
  const purse = KeyPair.generate();
  const pursePublicKey = bytesToHex(purse.publicKey.serialize());
  const message = bindingMessage(accountAddress, pursePublicKey);

  const signed = await provider.sign(message);
  if (signed.kind !== 'ok') return signed;

  const attestation: BindingAttestation = {
    accountAddress,
    accountPublicKey: signed.value.publicKey,
    pursePublicKey,
    bindingSignature: signed.value.signature,
  };
  return { kind: 'ok', value: { accountAddress, purse, attestation } };
}

/** Test-only identity construction: the account key is available locally. */
export function localIdentity(accountKey: KeyPair, purse: KeyPair): Identity {
  const pursePublicKey = bytesToHex(purse.publicKey.serialize());
  return {
    accountAddress: bytesToHex(accountKey.toAddress().serialize()),
    purse,
    attestation: createBindingAttestation(accountKey, pursePublicKey),
  };
}

/**
 * Authors signed log entries. Tracks the head hash and logical clock so callers
 * never have to. Registration entries automatically carry the attestation;
 * round entries automatically get a content-derived nonce so the same entry
 * built on two devices collapses to one (GAP 1).
 */
export class EntryAuthor {
  #headHash: string | null;
  #clock: number;

  constructor(
    private readonly identity: Identity,
    entries: readonly LogEntry[] = [],
  ) {
    this.#headHash = entries.length ? entryHash(entries[entries.length - 1] as LogEntry) : null;
    this.#clock = entries.reduce((max, e) => Math.max(max, e.logicalClock), 0);
  }

  get headHash(): string | null {
    return this.#headHash;
  }

  /** Re-point the author at the current log after a sync. */
  sync(entries: readonly LogEntry[]): void {
    this.#headHash = entries.length ? entryHash(entries[entries.length - 1] as LogEntry) : null;
    this.#clock = entries.reduce((max, e) => Math.max(max, e.logicalClock), 0);
  }

  author(entryType: EntryType, payload: Record<string, unknown>): LogEntry {
    const isOpen = entryType === 'LEDGER_OPEN';
    const fullPayload =
      isOpen || entryType === 'MEMBER_JOIN'
        ? {
            ...payload,
            accountPublicKey: this.identity.attestation.accountPublicKey,
            bindingSignature: this.identity.attestation.bindingSignature,
          }
        : payload;

    const nonce = DETERMINISTIC_ENTRIES.has(entryType)
      ? deterministicNonce(entryType, fullPayload)
      : randomHex(16);

    const entry = signEntry(
      {
        prevEntryHash: isOpen ? null : this.#headHash,
        entryType,
        payload: fullPayload,
        authorAddress: this.identity.accountAddress,
        pursePublicKey: bytesToHex(this.identity.purse.publicKey.serialize()),
        nonce,
        logicalClock: isOpen ? 0 : this.#clock + 1,
      },
      this.identity.purse,
    );
    this.#headHash = entryHash(entry);
    this.#clock = entry.logicalClock;
    return entry;
  }
}

/** The wire record the relay stores: the signed entry plus its content cursors. */
export function toRelayRecord(entry: LogEntry): Record<string, unknown> {
  return { ...entry, entryId: entryId(entry), entryHash: entryHash(entry) };
}
