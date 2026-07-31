/**
 * App half. Boots the shell — theme, language, provider — and renders the
 * ledger from the derived view model. The read-only preview paints immediately
 * (no wallet interaction needed to look); the wallet connects in the background.
 *
 * This wires the shell and the state layer; the full multi-screen flow set
 * (add/accept/settle/reconcile and every degraded state) is built on top of
 * this in Phase 5.
 */
import { getHostLanguage } from '@nimiq/mini-app-sdk';
import { showNetworkChip } from '../adapters/network-guard.js';
import { TESTNET, type NetworkId } from '../adapters/types.js';
import { createServices } from './services.js';
import type { LedgerViewModel } from '../state/ledger-state.js';
import { Translator, normalizeLang } from '../shell/i18n.js';
import { parseLedgerRoute } from '../shell/origin.js';
import { LocalThemeStore, applyTheme, resolveTheme, toggleTheme, type Theme } from '../shell/theme.js';

const TOKENS = `
:root.tka{--pg:#14100E;--card:#1C1512;--cardHov:#261E18;--tx:#F5F0E8;--sec:#A79E94;--mut:#8A8279;--hl:#2A221D;--btn:#F5F0E8;--btnTx:#1A140F;--amb:#E8940C}
:root.tkl{--pg:#FFFFFF;--card:#F7F5F2;--cardHov:#EFEBE4;--tx:#1C1512;--sec:#55504C;--mut:#756D63;--hl:#E3DED7;--btn:#1C1512;--btnTx:#FFFFFF;--amb:#A05E00}
body{margin:0;background:var(--pg);color:var(--tx);font-family:Mulish,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.wrap{max-width:440px;margin:0 auto;min-height:100vh;padding:16px calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
.hdr{display:flex;align-items:center;gap:10px;padding:8px 2px 18px}
.chip{font:800 10px ui-monospace,monospace;padding:3px 8px;border-radius:99px;background:var(--amb);color:#14100E}
.hero{background:var(--card);border-radius:16px;padding:22px 20px;text-align:center}
.pos{font-size:40px;font-weight:900;letter-spacing:-0.02em}
.sub{color:var(--sec);font-size:13px;font-weight:700;margin-top:4px}
.row{display:flex;align-items:center;height:52px;border-top:1px solid var(--hl);gap:10px}
.btn{height:48px;border-radius:12px;background:var(--btn);color:var(--btnTx);font-weight:800;font-size:15px;display:flex;align-items:center;justify-content:center;border:none;width:100%;margin-top:12px}
.tog{margin-left:auto;background:none;border:1px solid var(--hl);color:var(--sec);border-radius:99px;padding:6px 12px;font-weight:700;font-size:12px}
.mut{color:var(--mut);font-size:12.5px}
`;

function nim(luna: bigint): string {
  const neg = luna < 0n;
  const abs = neg ? -luna : luna;
  const whole = abs / 100000n;
  return `${neg ? '−' : ''}${whole.toLocaleString('en-US')}`;
}

export async function mountApp(): Promise<void> {
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Mulish:wght@400;600;700;800;900&display=swap';
  document.head.appendChild(fontLink);
  const style = document.createElement('style');
  style.textContent = TOKENS;
  document.head.appendChild(style);

  const themeStore = new LocalThemeStore(safeStorage());
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  let theme: Theme = resolveTheme(themeStore, prefersDark);
  applyTheme(document.documentElement, theme);

  const t = new Translator(normalizeLang(getHostLanguage()));
  const ledgerId = parseLedgerRoute(location.pathname);
  const network: NetworkId = TESTNET; // detected/confirmed from the first signed tx

  const root = document.getElementById('root') ?? document.body;
  render(root, t, theme, network, ledgerId, null, () => {
    theme = toggleTheme(theme);
    themeStore.set(theme);
    applyTheme(document.documentElement, theme);
    // re-render on toggle
    mountApp().catch(() => {});
  });

  // Connect the wallet in the background — the preview above is already visible.
  const services = createServices(network);
  await services.provider.init();
}

function render(
  root: HTMLElement,
  t: Translator,
  _theme: Theme,
  network: NetworkId,
  ledgerId: string | null,
  vm: LedgerViewModel | null,
  onToggleTheme: () => void,
): void {
  const owed = vm?.myPosition ?? 0n;
  const heading = owed > 0n ? t.t('ledger.youAreOwed') : owed < 0n ? t.t('ledger.youOwe') : t.t('ledger.settled');
  root.innerHTML = `
    <div class="wrap">
      <div class="hdr">
        <strong style="font-size:17px">${t.t('app.name')}</strong>
        ${showNetworkChip(network) ? `<span class="chip">${t.t('network.testnet')}</span>` : ''}
        <button class="tog" id="theme-toggle">◐</button>
      </div>
      <div class="hero">
        <div class="pos">${nim(owed)}<span style="font-size:16px;color:var(--sec);font-weight:800"> NIM</span></div>
        <div class="sub">${heading}</div>
      </div>
      ${ledgerId ? '' : `<p class="mut" style="margin-top:16px">Open a ledger from an invite link, or create one to start a shared tab.</p>`}
      <button class="btn" id="primary">${t.t('ledger.settleUp')}</button>
      <p class="mut" style="margin-top:16px;text-align:center">Read-only preview — no wallet interaction needed to look.</p>
    </div>`;
  document.getElementById('theme-toggle')?.addEventListener('click', onToggleTheme);
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
