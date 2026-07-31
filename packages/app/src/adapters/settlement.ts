/**
 * Settlement construction and the Test M branch.
 *
 * A settlement leg is byte-identical across devices when every field is derived
 * from the log (recipient, value, fee 0, anchor data, validityStartHeight from
 * ROUND_OPEN). Two idempotency strategies, selected at runtime from the Test M
 * probe result — never guessed:
 *
 *  - `deterministic`: the leg is constructed deterministically and a duplicate
 *    broadcast is a mempool re-broadcast of one transaction, so exactly one
 *    payment lands. Used by purse mode always, and by manual mode WHEN the
 *    wallet honours an explicit fee:0 and validityStartHeight.
 *  - `locked`: the wallet overrides fee or validityStartHeight, so two devices
 *    would produce different transactions. Manual mode then guards each leg with
 *    a round-level broadcast marker in the log and a visible "already in flight"
 *    warning. Tracked as an issue until Test M settles which path manual uses.
 */
import { buildSettlementLeg, type BuildLegParams, type SettlementLeg } from '@tally/core/tx';
import type { BasicTxWithDataParams } from './types.js';

export type SettlementMode = 'purse' | 'manual';
export type IdempotencyStrategy = 'deterministic' | 'locked';

/** Pick the idempotency strategy. Purse mode is always deterministic. */
export function chooseIdempotencyStrategy(
  mode: SettlementMode,
  manualHonoursExplicitFields: boolean,
): IdempotencyStrategy {
  if (mode === 'purse') return 'deterministic';
  return manualHonoursExplicitFields ? 'deterministic' : 'locked';
}

/** Purse-mode leg: constructed and signed locally by the purse (0 dialogs). */
export function buildPurseLeg(params: BuildLegParams): SettlementLeg {
  return buildSettlementLeg(params);
}

/**
 * Manual-mode leg parameters for `provider.sendBasicTransactionWithData`, with
 * fee and validityStartHeight EXPLICIT so that — if the wallet honours them —
 * two devices produce byte-identical account-signed transactions and inherit
 * purse mode's one-payment guarantee. `anchor` and `validityStartHeight` must
 * come from the round's ROUND_OPEN log entry, never from the chain at send time.
 */
export function buildManualLegParams(input: {
  recipient: string;
  value: bigint;
  anchor: string;
  anchorHeight: number;
}): BasicTxWithDataParams {
  return {
    recipient: input.recipient,
    value: input.value,
    fee: 0n,
    data: input.anchor,
    validityStartHeight: input.anchorHeight,
  };
}

/**
 * For the `locked` strategy: given the legs already recorded as broadcast for a
 * round (from the shared log), decide whether this device may broadcast `legKey`
 * or must instead show the "already in flight" warning.
 */
export function mayBroadcastUnderLock(legKey: string, alreadyBroadcastLegKeys: ReadonlySet<string>): {
  broadcast: boolean;
  warn: boolean;
} {
  const seen = alreadyBroadcastLegKeys.has(legKey);
  return { broadcast: !seen, warn: seen };
}
