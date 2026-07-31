/**
 * Deterministic settlement transaction construction — PRD 5.4 — and purse
 * derivation — PRD 3.1.
 *
 * Every field of a settlement leg is DERIVED, never observed: sender from the
 * purse, recipient/value from the plan, fee always 0n, data from the anchor,
 * and `validityStartHeight` from the round's ROUND_OPEN log entry. Nothing
 * here reads the chain, the clock, or anything else two devices could see
 * differently. Same log ⇒ same bytes ⇒ same hash ⇒ a second broadcast is a
 * mempool re-broadcast, not a second payment.
 */
import { Address, Hash, KeyPair, PrivateKey, type Transaction, TransactionBuilder } from '@nimiq/core';
import { bytesToHex, concatBytes, hexToBytes, utf8 } from '../internal/bytes.js';
import { encodeAnchor, ledgerTagFromGenesisHash } from '../anchor/index.js';
import { MAX_ANCHOR_HEIGHT, MAX_LUNA, type SettlementPlan, type Transfer } from '../netting/index.js';

export const TESTNET_NETWORK_ID = 5;
export const MAINNET_NETWORK_ID = 24;

export class TxBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxBuildError';
  }
}

// --- purse derivation (PRD 3.1) --------------------------------------------

export const PURSE_DOMAIN_SEPARATOR = 'tally-purse-binding-v1';

/**
 * seed = Blake2b(domainSeparator || bindingSignature), purse = derive(seed).
 *
 * Pure: the same wallet binding signature always yields the same purse, which
 * is what makes the purse recoverable on any device from the same account
 * with nothing written down. Ed25519 signatures are deterministic per
 * RFC 8032, so the wallet returns a stable 64-byte signature for the fixed
 * binding message — verified against Nimiq Pay by harness Test 1.
 */
export function derivePurse(
  bindingSignature: Uint8Array,
  domainSeparator: string = PURSE_DOMAIN_SEPARATOR,
): KeyPair {
  if (!(bindingSignature instanceof Uint8Array) || bindingSignature.length !== 64) {
    throw new TxBuildError('bindingSignature must be the 64-byte Ed25519 signature from the wallet');
  }
  if (domainSeparator.length === 0) throw new TxBuildError('domainSeparator must not be empty');
  const seed = Hash.computeBlake2b(concatBytes(utf8(domainSeparator), bindingSignature));
  return KeyPair.derive(new PrivateKey(seed));
}

// --- settlement leg construction (PRD 5.4) ----------------------------------

export interface RoundContext {
  /** Round counter from the ROUND_OPEN log entry. */
  round: number;
  /**
   * The round's anchor height from the ROUND_OPEN log entry — the ONLY
   * legitimate source of validityStartHeight. Never read this from the chain
   * at broadcast time: two devices reading three blocks apart would produce
   * different bytes and therefore two real payments.
   */
  anchorHeight: number;
}

export interface BuildLegParams {
  purse: KeyPair;
  plan: SettlementPlan;
  /** 1-based index into plan.transfers — which leg to build. */
  index: number;
  /** The ledger genesis hash (entry hash of LEDGER_OPEN), 32 bytes or hex. */
  genesisHash: Uint8Array | string;
  /** The 20-byte round root from core/anchor computeRoundRoot. */
  roundRoot: Uint8Array;
  roundContext: RoundContext;
  /** Explicit by design: 5 = TestAlbatross, 24 = MainAlbatross. */
  networkId: number;
}

export interface SettlementLeg {
  tx: Transaction;
  /** Transaction hash — identical on every device that builds this leg. */
  hash: string;
  /** Full signed transaction, hex — the broadcastable bytes. */
  serializedHex: string;
  /** The anchor string carried in the data field. */
  anchor: string;
  transfer: Transfer;
}

function purseAddressHex(purse: KeyPair): string {
  return bytesToHex(purse.toAddress().serialize());
}

export function buildSettlementLeg(params: BuildLegParams): SettlementLeg {
  const { purse, plan, index, roundRoot, roundContext, networkId } = params;

  if (!Number.isSafeInteger(index) || index < 1 || index > plan.transfers.length) {
    throw new TxBuildError(`index ${index} outside 1..${plan.transfers.length}`);
  }
  const transfer = plan.transfers[index - 1] as Transfer;

  const sender = purseAddressHex(purse);
  if (sender !== transfer.from) {
    throw new TxBuildError(
      `purse ${sender} does not own leg ${index} (sender ${transfer.from}) — a purse can only sign its own leg`,
    );
  }
  if (typeof transfer.amount !== 'bigint' || transfer.amount <= 0n) {
    throw new TxBuildError('leg amount must be a positive bigint');
  }
  // Defense in depth: reject what the wasm layer would silently wrap mod 2^64.
  if (transfer.amount > MAX_LUNA) {
    throw new TxBuildError(`leg amount exceeds MAX_LUNA (${MAX_LUNA})`);
  }
  if (!Number.isSafeInteger(roundContext.anchorHeight) || roundContext.anchorHeight < 1) {
    throw new TxBuildError('roundContext.anchorHeight must be a positive integer from the ROUND_OPEN entry');
  }
  // A height above u32 wraps mod 2^32 in @nimiq/core (2^32 → validityStartHeight 0).
  if (roundContext.anchorHeight > MAX_ANCHOR_HEIGHT) {
    throw new TxBuildError(`roundContext.anchorHeight exceeds the u32 block-height ceiling (${MAX_ANCHOR_HEIGHT})`);
  }
  if (networkId !== TESTNET_NETWORK_ID && networkId !== MAINNET_NETWORK_ID) {
    throw new TxBuildError(`unknown networkId ${networkId} (5 = TestAlbatross, 24 = MainAlbatross)`);
  }

  const genesis =
    typeof params.genesisHash === 'string' ? hexToBytes(params.genesisHash) : params.genesisHash;
  const anchor = encodeAnchor({
    ledgerTag: ledgerTagFromGenesisHash(genesis),
    round: roundContext.round,
    index,
    count: plan.transfers.length,
    root: roundRoot,
  });

  const tx = TransactionBuilder.newBasicWithData(
    purse.toAddress(),
    new Address(hexToBytes(transfer.to)),
    utf8(anchor),
    transfer.amount,
    0n,
    roundContext.anchorHeight,
    networkId,
  );
  tx.sign(purse, undefined);

  return { tx, hash: tx.hash(), serializedHex: tx.toHex(), anchor, transfer };
}
