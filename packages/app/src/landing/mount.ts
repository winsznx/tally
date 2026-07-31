/**
 * Landing half. Renders the marketing page (design markup preserved verbatim in
 * landing.html) and fills in the live bits: a QR + deeplink for the current
 * origin, and — when the app is force-detected on desktop — the banner.
 */
import { deeplink, inviteUrl, parseLedgerRoute } from '../shell/origin.js';
import landingHtml from './landing.html?raw';
import { qrSvg } from './qr.js';

export function mountLanding(): void {
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href =
    'https://fonts.googleapis.com/css2?family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&family=Sora:wght@400;500;600;700;800&display=swap';
  document.head.appendChild(fontLink);
  document.body.style.cssText = 'margin:0;background:#FFFFFF;font-family:Sora,system-ui,sans-serif;color:#1C1512;font-variant-numeric:tabular-nums';

  const root = document.getElementById('root') ?? document.body;
  root.innerHTML = landingHtml;

  const origin = location.origin;
  const ledgerId = parseLedgerRoute(location.pathname);
  // A shared /l/:id link renders the landing with a QR for THAT specific ledger.
  const target = ledgerId ? inviteUrl(origin, ledgerId) : origin;
  const link = ledgerId ? deeplink(origin, ledgerId) : `nimiqpay://miniapp?url=${encodeURIComponent(origin)}`;

  for (const id of ['hero-qr', 'try-qr']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = qrSvg(target);
  }
  const dl = document.getElementById('hero-deeplink');
  if (dl) dl.textContent = link.length > 46 ? `${link.slice(0, 43)}…` : link;
}
