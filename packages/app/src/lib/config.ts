/**
 * Build-time configuration. Every value is a public endpoint; there are no
 * secrets in the frontend bundle.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');

/** 24 = Nimiq mainnet, 5 = testnet. Production is mainnet. */
export const NETWORK_ID: 5 | 24 = import.meta.env.VITE_NIMIQ_NETWORK === 'testnet' ? 5 : 24;

export const RPC_URL: string =
  import.meta.env.VITE_NIMIQ_RPC_URL ??
  (NETWORK_ID === 24 ? 'https://rpc.nimiqwatch.com' : 'https://rpc.testnet.nimiqwatch.com');

export const NETWORK_LABEL = NETWORK_ID === 24 ? 'Nimiq mainnet' : 'Nimiq testnet';

export const REPO_URL = 'https://github.com/winsznx/tally';

export function explorerTxUrl(hash: string): string {
  return NETWORK_ID === 24 ? `https://nimiq.watch/#${hash}` : `https://test.nimiq.watch/#${hash}`;
}

export function explorerAddressUrl(userFriendly: string): string {
  const compact = userFriendly.replace(/\s+/g, '');
  return NETWORK_ID === 24 ? `https://nimiq.watch/#${compact}` : `https://test.nimiq.watch/#${compact}`;
}

/** The origin the mini app is served from; invite links point here. */
export function appOrigin(): string {
  return import.meta.env.VITE_PUBLIC_ORIGIN ?? window.location.origin;
}

export function inviteUrl(tabId: string): string {
  return `${appOrigin()}/l/${tabId}`;
}

/** Opens the invite inside Nimiq Pay (documented deeplink format). */
export function nimiqPayDeeplink(url: string): string {
  return `https://nimpay.app/miniapps/open/${url.replace(/^https?:\/\//, '')}`;
}

export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev';
