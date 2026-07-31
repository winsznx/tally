/**
 * App half. Boots the shell, paints a read-only view immediately (looking at a
 * tab needs no wallet interaction at all), then syncs and wires every action to
 * the tested core functions.
 *
 * Dialog budget, and where it goes:
 *   join     listAccounts, then the binding signature. Two prompts, because the
 *            log requires an attested purse from a member's very first entry:
 *            there is no such thing as a member without one.
 *   fund     one sendBasicTransaction.
 *   settle   zero in purse mode. One per leg in manual mode.
 *   accept, reject, add, nudge, open a round: zero. The purse signs those.
 *
 * Every failure path lands on a designed state rather than an error page, and a
 * declined dialog is a normal outcome that resolves to a result.
 */
import { Address, TransactionBuilder } from '@nimiq/core';
import { getHostLanguage } from '@nimiq/mini-app-sdk';
import { replayState } from '@tally/core/log';
import { showNetworkChip } from '../adapters/network-guard.js';
import { TESTNET, type ChainTx, type NetworkId } from '../adapters/types.js';
import { Translator, normalizeLang } from '../shell/i18n.js';
import { parseLedgerRoute } from '../shell/origin.js';
import { LocalThemeStore, applyTheme, resolveTheme, toggleTheme, type Theme } from '../shell/theme.js';
import type { LedgerViewModel, ObservedLeg } from '../state/ledger-state.js';
import { membershipStatus, selectAddress, type AccountChoice } from './identity-state.js';
import { Ledger, purseAddressOf } from './ledger.js';
import { renderEntry, renderHome, type Degraded, type KnownTab } from './screens.js';
import { bindPurse, restoreIdentity, serializeIdentity, type Identity } from './session.js';
import { EXAMPLE_LEDGER } from '../config.js';
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
  myAddressForSettle: null,
  ignoredCount: 0,
};

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const toUserFriendly = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new Address(bytes).toUserFriendlyAddress();
};

export async function mountApp(): Promise<void> {
  injectHead();

  const themeStore = new LocalThemeStore(safeStorage());
  let theme: Theme = resolveTheme(themeStore, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  applyTheme(document.documentElement, theme);

  const t = new Translator(normalizeLang(getHostLanguage()));
  let network: NetworkId = TESTNET;
  const services = createServices(network);
  const ledgerId = parseLedgerRoute(location.pathname);
  const root = document.getElementById('root') ?? document.body;

  let degraded: Degraded = null;
  let view: LedgerViewModel = EMPTY_VIEW;
  let busy: string | null = null;
  let identity: Identity | null = null;
  let walletAddresses: string[] = [];
  let purseBalance: bigint | null = null;
  let headHeight: number | null = null;
  let mode: 'purse' | 'manual' = 'manual';
  const names = new Map<string, string>();

  const idKey = `tally.identity.${ledgerId ?? 'none'}`;
  const modeKey = `tally.mode.${ledgerId ?? 'none'}`;

  const ledger = ledgerId
    ? new Ledger(ledgerId, {
        relay: services.relay,
        cache: services.cache,
        chain: services.chain,
        provider: services.provider,
        network,
      })
    : null;

  // --- rendering ----------------------------------------------------------

  const knownTabs = (): KnownTab[] => {
    const raw = safeStorage()?.getItem('tally.tabs');
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as KnownTab[]).slice(0, 6);
    } catch {
      return [];
    }
  };

  const rememberTab = (id: string, name: string | null): void => {
    const tabs = knownTabs().filter((tb) => tb.ledgerId !== id);
    safeStorage()?.setItem('tally.tabs', JSON.stringify([{ ledgerId: id, name }, ...tabs].slice(0, 6)));
  };

  const paint = (): void => {
    // The bare origin is the Demo URL. It gets a real entry screen, never an
    // empty solo tab with a dead button.
    if (!ledger) {
      root.innerHTML = renderEntry(knownTabs(), t);
      return;
    }
    const status = ledger
      ? membershipStatus(replayState([...ledger.entries]), walletAddresses, identity?.accountAddress ?? null)
      : { kind: 'not-a-member' as const };
    if (status.kind === 'account-switched') degraded = { kind: 'accountSwitched', joinedWith: status.joinedWith };

    root.innerHTML = renderHome(view, names, t, degraded, {
      showNetworkChip: showNetworkChip(network),
      canSettle: true,
      membership: status.kind,
      purseBalance,
      purseAddress: identity ? purseAddressOf(bytesToHex(identity.purse.publicKey.serialize())) : null,
      mode,
      busy,
    });
  };

  const withBusy = async (label: string, fn: () => Promise<void>): Promise<void> => {
    busy = label;
    paint();
    try {
      await fn();
    } catch (e) {
      // Never an error page. Say what happened and leave the ledger readable.
      degraded = { kind: 'offline', source: ledger?.syncSource === 'cache' ? 'cache' : 'none' };
      console.error(e);
    } finally {
      busy = null;
      refreshView();
    }
  };

  const refreshView = (): void => {
    if (ledger) view = ledger.view(headHeight, services.clock.now());
    paint();
  };

  // --- identity -----------------------------------------------------------

  const loadIdentity = (): void => {
    const raw = safeStorage()?.getItem(idKey);
    if (!raw) return;
    try {
      identity = restoreIdentity(JSON.parse(raw) as never);
      ledger?.setIdentity(identity);
      mode = safeStorage()?.getItem(modeKey) === 'purse' ? 'purse' : 'manual';
    } catch {
      identity = null;
    }
  };

  const saveIdentity = (): void => {
    if (identity) safeStorage()?.setItem(idKey, JSON.stringify(serializeIdentity(identity)));
  };

  /**
   * Join. `listAccounts` decides WHICH address is the user (GAP A), then the
   * binding signature attests the purse. Declining either is a normal outcome.
   */
  const doJoin = async (): Promise<void> => {
    if (!ledger) return;
    const accounts = await services.provider.listAccounts();
    if (accounts.kind === 'declined') {
      degraded = { kind: 'declined' };
      return;
    }
    if (accounts.kind === 'error') {
      degraded = { kind: 'offline', source: 'none' };
      return;
    }
    walletAddresses = accounts.value.map((a) => bytesToHex(Address.fromString(a).serialize()));
    const choices: AccountChoice[] = walletAddresses.map((address) => ({
      address,
      label: toUserFriendly(address),
      balance: 0n,
    }));
    const selection = selectAddress(choices);
    if (selection.kind === 'none') return;
    const chosen =
      selection.kind === 'single'
        ? selection.address
        : (window.prompt(
            `Which address should join this tab?\n\n${selection.choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n')}`,
            '1',
          )
            ? selection.choices[
                Math.max(0, Math.min(selection.choices.length - 1, Number(window.prompt('Number:', '1')) - 1))
              ]?.address
            : undefined) ?? selection.choices[0]?.address;
    if (!chosen) return;

    const bound = await bindPurse(services.provider, chosen);
    if (bound.kind === 'declined') {
      degraded = { kind: 'declined' };
      return;
    }
    if (bound.kind === 'error') {
      degraded = { kind: 'offline', source: 'none' };
      return;
    }
    identity = bound.value;
    saveIdentity();
    ledger.setIdentity(identity);
    await ledger.join();
    await ledger.sync();
  };

  /** Arm the purse for dialog-free settlement. Funding is the second prompt. */
  const doFund = async (): Promise<void> => {
    if (!identity) return;
    const purse = purseAddressOf(bytesToHex(identity.purse.publicKey.serialize()));
    const res = await services.provider.sendBasicTransaction({
      recipient: toUserFriendly(purse),
      value: 500_00000n, // 500 NIM, a sensible demo top-up
    });
    if (res.kind === 'declined') {
      degraded = { kind: 'declined' };
      return;
    }
    if (res.kind === 'error') return;
    // The wallet's own network, learned from the first tx it signs back (GAP 3).
    if (res.value.networkId !== network) {
      network = res.value.networkId as NetworkId;
    }
    mode = 'purse';
    safeStorage()?.setItem(modeKey, 'purse');
    await refreshPurseBalance();
  };

  /**
   * Empty the purse back to the account. One tap, from every screen. This is a
   * user-initiated one-off rather than a settlement leg, so reading the chain
   * head here is correct: no other device is building the same bytes.
   */
  const doWithdraw = async (): Promise<void> => {
    if (!identity) return;
    const purseAddr = purseAddressOf(bytesToHex(identity.purse.publicKey.serialize()));
    const balance = await services.chain.getBalance(toUserFriendly(purseAddr));
    if (balance <= 0n) return;
    const head = await services.chain.headHeight();
    const tx = TransactionBuilder.newBasic(
      identity.purse.toAddress(),
      Address.fromString(toUserFriendly(identity.accountAddress)),
      balance,
      0n,
      head,
      network,
    );
    tx.sign(identity.purse, undefined);
    await services.chain.broadcast(tx.toHex());
    await refreshPurseBalance();
  };

  const refreshPurseBalance = async (): Promise<void> => {
    if (!identity) return;
    try {
      const purse = purseAddressOf(bytesToHex(identity.purse.publicKey.serialize()));
      purseBalance = await services.chain.getBalance(toUserFriendly(purse));
    } catch {
      purseBalance = null;
    }
  };

  /**
   * Settle my legs. validityStartHeight comes from the ROUND_OPEN entry inside
   * core/tx and nowhere else, which is what stops two devices producing two
   * payments. Nothing here reads the chain head.
   */
  const doSettle = async (): Promise<void> => {
    if (!ledger) return;
    const outcomes = await ledger.settleMyLegs(mode);
    if (outcomes.some((o) => o.declined)) degraded = { kind: 'declined' };
    await observeChain();
  };

  /** Match on-chain settlements to plan legs so partial rounds are truthful. */
  const observeChain = async (): Promise<void> => {
    if (!ledger) return;
    const state = replayState([...ledger.entries]);
    if (!state.openRound) return;
    const observed: ObservedLeg[] = [];
    for (const m of state.members) {
      for (const addr of [m.address, purseAddressOf(m.pursePublicKey)]) {
        try {
          const txs = await services.chain.getTransactionsByAddress(toUserFriendly(addr), 20);
          for (const tx of txs as ChainTx[]) {
            observed.push({
              from: bytesToHex(Address.fromString(tx.sender).serialize()),
              to: bytesToHex(Address.fromString(tx.recipient).serialize()),
              amount: tx.value,
              txHash: tx.hash,
              // Nothing counts as landed before macro-block finality.
              confirmed: tx.confirmed,
            });
          }
        } catch {
          // A read failure is not a settlement failure; the leg stays waiting.
        }
      }
    }
    ledger.setObservedLegs(observed);
  };

  // --- action dispatch ----------------------------------------------------

  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest('[data-action]');
    if (!(el instanceof HTMLElement)) return;
    const action = el.dataset['action'];
    const id = el.dataset['id'];

    switch (action) {
      case 'theme':
        theme = toggleTheme(theme);
        themeStore.set(theme);
        applyTheme(document.documentElement, theme);
        return;

      case 'example':
        location.href = `/l/${EXAMPLE_LEDGER}${location.search}`;
        return;

      case 'open-tab':
        if (id) location.href = `/l/${id}${location.search}`;
        return;

      case 'start-tab':
        void (async () => {
          try {
            const created = await services.relay.createLedger(network);
            location.href = `/l/${created.ledgerId}${location.search}`;
          } catch {
            window.prompt('Could not reach the relay. Try again when you are back online.');
          }
        })();
        return;

      case 'join':
        void withBusy('Joining', doJoin);
        return;

      case 'bind':
        void withBusy('Arming the purse', async () => {
          await doFund();
        });
        return;

      case 'skip-purse':
        mode = 'manual';
        safeStorage()?.setItem(modeKey, 'manual');
        refreshView();
        return;

      case 'fund':
        void withBusy('Topping up', doFund);
        return;

      case 'withdraw':
        void withBusy('Withdrawing', doWithdraw);
        return;

      case 'accept':
        if (id) void withBusy('Accepting', async () => { await ledger?.accept(id); });
        return;

      case 'reject':
        if (id) void withBusy('Rejecting', async () => { await ledger?.reject(id); });
        return;

      case 'add': {
        const who = window.prompt('Who owes you? Paste their address.');
        if (!who) return;
        const amount = window.prompt('How much, in NIM?');
        if (!amount) return;
        const memo = window.prompt('What for? (optional)') ?? undefined;
        const luna = toLuna(amount);
        const me = identity?.accountAddress;
        if (luna === null || !me) return;
        void withBusy('Adding', async () => {
          await ledger?.propose(bytesToHex(Address.fromString(who).serialize()), me, luna, memo);
        });
        return;
      }

      case 'call-tab':
        void withBusy('Opening a round', async () => {
          await ledger?.openRound();
          await observeChain();
        });
        return;

      case 'settle':
        void withBusy(mode === 'purse' ? 'Settling' : 'Settling, approve each payment', doSettle);
        return;

      case 'nudge': {
        // A share sheet, not a notification. Mini apps have no push channel.
        const who = el.dataset['who'] ?? '';
        const text = `Your share of ${view.name ?? 'our tab'} is waiting. Open Tally: ${location.href}`;
        share(text, `Nudge ${names.get(who) ?? 'them'}, copy this:`);
        return;
      }

      case 'invite': {
        const url = location.href;
        const text = `Join our tab on Tally. Anyone with this link can see it, so only share it with people in it: ${url}`;
        share(text, 'Copy this invite:');
        return;
      }

      case 'retry':
        degraded = null;
        void withBusy('Reconnecting', async () => {
          await ledger?.sync();
          headHeight = await services.chain.headHeight().catch(() => null);
          await observeChain();
        });
        return;

      case 'join-fresh':
        safeStorage()?.removeItem?.(idKey);
        identity = null;
        degraded = null;
        void withBusy('Joining', doJoin);
        return;

      case 'topup':
        void withBusy('Topping up', doFund);
        return;

      default:
        return;
    }
  });

  // --- boot ---------------------------------------------------------------

  paint(); // instant, no network, no wallet

  if (ledger) {
    loadIdentity();
    ledger.loadFromCache();
    refreshView();

    rememberTab(ledgerId as string, null);
    const source = await ledger.sync();
    if (source !== 'relay') degraded = { kind: 'offline', source: source === 'cache' ? 'cache' : 'none' };
    try {
      headHeight = await services.chain.headHeight();
    } catch {
      degraded ??= { kind: 'consensusLost' };
    }
    await observeChain();
    await refreshPurseBalance();
    rememberTab(ledgerId as string, view.name);
    refreshView();
  }

  // The wallet connects last. Nothing above waited on it.
  const init = await services.provider.init();
  if (init.insideNimiqPay && identity) {
    const accounts = await services.provider.listAccounts();
    if (accounts.kind === 'ok') {
      walletAddresses = accounts.value.map((a) => bytesToHex(Address.fromString(a).serialize()));
      refreshView(); // may surface the account-switched state (GAP B)
    }
  }
}

/** The share sheet, falling back to copyable text where it is unavailable. */
function share(text: string, fallbackLabel: string): void {
  const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
  if (typeof nav.share === 'function') {
    void nav.share({ text }).catch(() => window.prompt(fallbackLabel, text));
    return;
  }
  window.prompt(fallbackLabel, text);
}

/** "12.5" NIM to Luna as a bigint, without letting a float touch it. */
function toLuna(input: string): bigint | null {
  const m = /^\s*(\d+)(?:[.,](\d{1,5}))?\s*$/.exec(input);
  if (!m) return null;
  const whole = BigInt(m[1] as string);
  const frac = BigInt(((m[2] ?? '') + '00000').slice(0, 5));
  return whole * 100_000n + frac;
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

function safeStorage(): (Pick<Storage, 'getItem' | 'setItem'> & { removeItem?(k: string): void }) | undefined {
  try {
    window.localStorage.getItem('tally.probe');
    return window.localStorage;
  } catch {
    return undefined;
  }
}
