/**
 * App half. Boots the shell — theme, language, services — paints the read-only
 * view immediately (no wallet interaction needed to look), then syncs in the
 * background and re-renders.
 *
 * Every failure path lands on a designed degraded state rather than an error
 * page: a dead relay renders the cached ledger read-only, a declined dialog
 * reads as a normal outcome, lost consensus freezes settlement while
 * obligations still record, and a forked log refuses to open a round.
 */
import { getHostLanguage } from '@nimiq/mini-app-sdk';
import { showNetworkChip } from '../adapters/network-guard.js';
import { TESTNET, type NetworkId } from '../adapters/types.js';
import { Translator, normalizeLang } from '../shell/i18n.js';
import { parseLedgerRoute } from '../shell/origin.js';
import { LocalThemeStore, applyTheme, resolveTheme, toggleTheme, type Theme } from '../shell/theme.js';
import type { LedgerViewModel } from '../state/ledger-state.js';
import { Ledger } from './ledger.js';
import { renderHome, type Degraded } from './screens.js';
import { createServices } from './services.js';
import { APP_CSS } from './styles.js';

const EMPTY_VIEW: LedgerViewModel = {
  name: null,
  genesisHash: null,
  members: [],
  myPosition: null,
  requestsForMe: [],
  awaitingOthers: [],
  preview: null,
  openRound: null,
  ignoredCount: 0,
};

export async function mountApp(): Promise<void> {
  injectHead();

  const themeStore = new LocalThemeStore(safeStorage());
  let theme: Theme = resolveTheme(themeStore, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  applyTheme(document.documentElement, theme);

  const t = new Translator(normalizeLang(getHostLanguage()));
  const network: NetworkId = TESTNET; // confirmed from the first wallet-signed tx (GAP 3)
  const services = createServices(network);
  const ledgerId = parseLedgerRoute(location.pathname);
  const root = document.getElementById('root') ?? document.body;

  let degraded: Degraded = null;
  let view: LedgerViewModel = EMPTY_VIEW;
  const names = new Map<string, string>();

  const paint = (): void => {
    root.innerHTML = renderHome(view, names, t, degraded, {
      showNetworkChip: showNetworkChip(network),
      canSettle: true,
    });
  };

  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest('[data-action]');
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset['action'] === 'theme') {
      theme = toggleTheme(theme);
      themeStore.set(theme);
      applyTheme(document.documentElement, theme);
    }
  });

  paint(); // first paint: instant, no network, no wallet

  if (ledgerId) {
    const ledger = new Ledger(ledgerId, {
      relay: services.relay,
      cache: services.cache,
      chain: services.chain,
      provider: services.provider,
      network,
    });
    ledger.loadFromCache(); // render the last-known state immediately
    view = ledger.view(null, services.clock.now());
    paint();

    const source = await ledger.sync();
    if (source !== 'relay') degraded = { kind: 'offline', source: source === 'cache' ? 'cache' : 'none' };
    let head: number | null = null;
    try {
      head = await services.chain.headHeight();
    } catch {
      degraded ??= { kind: 'consensusLost' };
    }
    view = ledger.view(head, services.clock.now());
    paint();
  }

  // The wallet connects last — the view above never waited on it.
  await services.provider.init();
}

function injectHead(): void {
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Mulish:wght@400;600;700;800;900&display=swap';
  document.head.appendChild(font);
  const style = document.createElement('style');
  style.textContent = APP_CSS;
  document.head.appendChild(style);
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    window.localStorage.getItem('tally.probe');
    return window.localStorage;
  } catch {
    return undefined;
  }
}
