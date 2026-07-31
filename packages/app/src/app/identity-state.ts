/**
 * Which address is "me", and what happens when that changes.
 *
 * GAP A — address selection. `listAccounts()` returns several addresses; nothing
 * else decides which one the user is. One address is used without a prompt; more
 * than one gets a picker showing label and balance so the choice is meaningful.
 * The choice is then baked into MEMBER_JOIN as `accountAddress`, so from that
 * point on "which address am I in this ledger" is answered by REPLAY, never by
 * separate stored state that could drift — and the purse is keyed off the
 * ledger's joined address, never off `listAccounts()[0]`.
 *
 * GAP B — account switch. If the user switches accounts in Nimiq Pay they become
 * a different person to Tally: the purse will not derive and the ledger would
 * look empty. That must never render as data loss; it is a designed state that
 * names the address the tab was joined with.
 */
import type { LedgerState } from '@tally/core/log';

export interface AccountChoice {
  address: string;
  /** Wallet label if the host provides one, else a shortened address. */
  label: string;
  /** Balance in Luna, for making the choice meaningful. */
  balance: bigint;
}

export type AddressSelection =
  | { kind: 'none' }
  | { kind: 'single'; address: string }
  | { kind: 'pick'; choices: AccountChoice[] };

/** One address is used silently; several require an explicit choice. */
export function selectAddress(choices: AccountChoice[]): AddressSelection {
  if (choices.length === 0) return { kind: 'none' };
  if (choices.length === 1) return { kind: 'single', address: (choices[0] as AccountChoice).address };
  return { kind: 'pick', choices };
}

/**
 * The address I joined THIS ledger with, read from replay. Returns null if none
 * of the wallet's addresses is a member — that is the join case, not an error.
 */
export function joinedAddress(state: LedgerState, walletAddresses: readonly string[]): string | null {
  const wallet = new Set(walletAddresses);
  const mine = state.members.find((m) => wallet.has(m.address));
  return mine?.address ?? null;
}

export type MembershipStatus =
  | { kind: 'not-a-member' }
  | { kind: 'active'; address: string }
  | { kind: 'left'; address: string }
  /** GAP B: the ledger was joined with an address this wallet no longer offers. */
  | { kind: 'account-switched'; joinedWith: string };

/**
 * Reconcile the ledger's membership against the wallet's current addresses.
 * Called on every app open, because the user may have switched accounts in
 * Nimiq Pay since last time.
 */
export function membershipStatus(
  state: LedgerState,
  walletAddresses: readonly string[],
  /** The address previously used for this ledger, if the device remembers one. */
  rememberedAddress: string | null,
): MembershipStatus {
  const wallet = new Set(walletAddresses);

  const current = state.members.find((m) => wallet.has(m.address));
  if (current) return current.active ? { kind: 'active', address: current.address } : { kind: 'left', address: current.address };

  // No wallet address is a member. If this device previously acted as a member
  // whose address the wallet no longer offers, the account was switched — say so
  // by name instead of rendering an empty ledger.
  if (rememberedAddress && state.members.some((m) => m.address === rememberedAddress)) {
    return { kind: 'account-switched', joinedWith: rememberedAddress };
  }
  return { kind: 'not-a-member' };
}
