/**
 * Build-time configuration. The relay URL is injected at build time via
 * `VITE_RELAY_URL` and is never hardcoded, so a preview build can point at a
 * preview relay:
 *
 *   VITE_RELAY_URL=https://tally-relay-preview.workers.dev pnpm build
 *
 * There are NO secrets here and none anywhere else in this repo — every value
 * below is a public endpoint. That is a deliberate property of the
 * architecture: the relay stores only signed public entries and is untrusted,
 * so there is nothing to keep secret.
 */

/** The log relay. Defaults to `wrangler dev`'s local port for development. */
export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? 'http://localhost:8787';

/**
 * Public testnet JSON-RPC. Verified in Phase 0: CORS `*`, rate-limited, and all
 * six methods we need are permitted. Overridable for a private node.
 */
export const TESTNET_RPC_URL: string =
  import.meta.env.VITE_TESTNET_RPC_URL ?? 'https://rpc.testnet.nimiqwatch.com/';

/** Public mainnet JSON-RPC, used when the wallet reports mainnet (GAP 3). */
export const MAINNET_RPC_URL: string =
  import.meta.env.VITE_MAINNET_RPC_URL ?? 'https://rpc.nimiqwatch.com';

/**
 * A permanent, read-only demo ledger carrying the full PRD 3.2 dataset, so the
 * bare origin can show what Tally does in one tap instead of an empty tab. It is
 * seeded separately from any recording ledger (`pnpm seed:demo --example`) so a
 * demo run cannot break it.
 */
export const EXAMPLE_LEDGER: string =
  import.meta.env.VITE_EXAMPLE_LEDGER ?? 'gam752kp3xu353nxgfqpmm56a7';

export function rpcUrlFor(networkId: number): string {
  return networkId === 24 ? MAINNET_RPC_URL : TESTNET_RPC_URL;
}
