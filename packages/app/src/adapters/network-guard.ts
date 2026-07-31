/**
 * Network scoping (GAP 3). Judges open Nimiq Pay on MAINNET by default, so the
 * app must support both networks — but a ledger is network-scoped: a mainnet
 * member cannot join a testnet ledger, or the ledger becomes incoherent (its
 * anchors and balances live on one chain). The wallet cannot report its network
 * in advance, so we detect it from the first returned signed transaction and
 * refuse a mismatch with a clear message rather than producing a broken ledger.
 */
import { type NetworkId, networkName } from './types.js';

export type NetworkGuardResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Compare the wallet's detected network against the ledger's network.
 * `detected` is undefined until the first signed tx comes back — before then we
 * optimistically allow (no second dialog has happened yet).
 */
export function checkNetwork(ledgerNetwork: NetworkId, detected: number | undefined): NetworkGuardResult {
  if (detected === undefined) return { ok: true };
  if (detected === ledgerNetwork) return { ok: true };
  return {
    ok: false,
    message:
      `This ledger is on ${networkName(ledgerNetwork)}, but your wallet is on ` +
      `${detected === 24 ? 'mainnet' : detected === 5 ? 'testnet' : `network ${detected}`}. ` +
      `Open a ${networkName(ledgerNetwork)} ledger instead — a wallet can only take part in ledgers on its own network.`,
  };
}

/** Whether to show the network chip in the header — only for testnet (mainnet is the normal case). */
export function showNetworkChip(network: NetworkId): boolean {
  return network !== 24;
}
