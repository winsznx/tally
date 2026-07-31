/**
 * The origin split (Phase 4 / GAP 7). One origin serves both halves:
 *   window.nimiqPay present  → the mini app
 *   absent                   → the landing page
 *   ?app=1                   → force the app (for testing outside Nimiq Pay)
 * Each half is lazy-loaded so neither bundle carries the other.
 *
 * Also parses the invite route `/l/:ledgerId` so a shared link opens straight
 * into that ledger (in the app) or renders its landing + QR (on desktop).
 */
export type Half = 'app' | 'landing';

export function pickHalf(win: { nimiqPay?: unknown; location: { search: string } }): Half {
  if (win.nimiqPay !== undefined) return 'app';
  if (/[?&]app=1(?:&|$)/.test(win.location.search)) return 'app';
  return 'landing';
}

/** `/l/<ledgerId>` → the ledger id, else null. Ids are base32 (GAP 7). */
export function parseLedgerRoute(pathname: string): string | null {
  const m = /^\/l\/([a-z2-7]{10,64})\/?$/.exec(pathname);
  return m ? (m[1] as string) : null;
}

export function inviteUrl(origin: string, ledgerId: string): string {
  return `${origin}/l/${ledgerId}`;
}

/** Deeplink that opens the mini app inside Nimiq Pay at a specific ledger. */
export function deeplink(origin: string, ledgerId: string): string {
  return `nimiqpay://miniapp?url=${encodeURIComponent(inviteUrl(origin, ledgerId))}`;
}

/**
 * crypto.randomUUID is secure-context only, and dev over http://<lan-ip> is not
 * one. Feature-detect and fall back to getRandomValues (a v4-shaped id).
 */
export function randomId(cryptoObj: Crypto = crypto): string {
  if (typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  const b = new Uint8Array(16);
  cryptoObj.getRandomValues(b);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
