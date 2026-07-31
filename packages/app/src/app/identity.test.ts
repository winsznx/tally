import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../adapters/cache.js';
import { LocalThemeStore, resolveTheme } from '../shell/theme.js';
import { Translator } from '../shell/i18n.js';
import { INVITE_DISCLOSURE, renderDegraded, renderShareSheet } from './screens.js';
import { joinedAddress, membershipStatus, selectAddress, type AccountChoice } from './identity-state.js';
import type { LedgerState } from '@tally/core/log';

const A = 'aa'.repeat(20);
const B = 'bb'.repeat(20);
const C = 'cc'.repeat(20);

const state = (members: { address: string; active: boolean }[]): LedgerState =>
  ({
    ledgerName: 'Trip',
    genesisHash: 'ff'.repeat(32),
    members: members.map((m) => ({ ...m, pursePublicKey: '11'.repeat(32) })),
    obligations: [],
    acceptedPending: [],
    openRound: null,
    lastClosedRound: 0,
    ignored: [],
  }) as unknown as LedgerState;

describe('GAP A — address selection', () => {
  const choices: AccountChoice[] = [
    { address: A, label: 'Main', balance: 500_000n },
    { address: B, label: 'Savings', balance: 12_000n },
  ];

  it('uses a single address without prompting', () => {
    expect(selectAddress([choices[0] as AccountChoice])).toEqual({ kind: 'single', address: A });
  });

  it('asks for a choice when the wallet holds several, keeping label and balance', () => {
    const sel = selectAddress(choices);
    expect(sel.kind).toBe('pick');
    if (sel.kind === 'pick') {
      expect(sel.choices.map((c) => c.label)).toEqual(['Main', 'Savings']);
      expect(sel.choices[0]?.balance).toBe(500_000n);
    }
  });

  it('handles a wallet with no addresses', () => {
    expect(selectAddress([])).toEqual({ kind: 'none' });
  });

  it('answers "which address am I here" from REPLAY, not stored state', () => {
    // The ledger was joined with B even though the wallet lists A first.
    expect(joinedAddress(state([{ address: B, active: true }]), [A, B])).toBe(B);
    expect(joinedAddress(state([{ address: C, active: true }]), [A, B])).toBeNull();
  });
});

describe('GAP B — account switch detection', () => {
  it('reports active membership when a wallet address is a member', () => {
    expect(membershipStatus(state([{ address: A, active: true }]), [A], null)).toEqual({ kind: 'active', address: A });
  });

  it('reports a departed membership distinctly from a switch', () => {
    expect(membershipStatus(state([{ address: A, active: false }]), [A], null)).toEqual({ kind: 'left', address: A });
  });

  it('detects a switch: the joined address is no longer offered by the wallet', () => {
    const status = membershipStatus(state([{ address: A, active: true }]), [B], A);
    expect(status).toEqual({ kind: 'account-switched', joinedWith: A });
  });

  it('a stranger opening the tab is simply not a member, not a switch', () => {
    expect(membershipStatus(state([{ address: A, active: true }]), [C], null)).toEqual({ kind: 'not-a-member' });
  });

  it('renders a designed state that names the address and never an empty ledger', () => {
    const html = renderDegraded({ kind: 'accountSwitched', joinedWith: A }, new Translator('en'));
    expect(html).toContain('different address');
    expect(html).toContain('aaaa'); // the joined address, shortened
    expect(html).toContain('Switch back to that address in Nimiq Pay');
    expect(html).toContain('nothing has been lost');
    expect(html).toContain('data-action="join-fresh"'); // the alternative
  });
});

describe('GAP D — the invite link is a capability', () => {
  it('the share sheet says in plain words that anyone with the link can see the tab', () => {
    const html = renderShareSheet('https://tally.pages.dev/l/abc', 'nimiqpay://miniapp?url=x', false);
    expect(html).toContain(INVITE_DISCLOSURE);
    expect(INVITE_DISCLOSURE).toContain('Anyone with this link can see this tab');
  });

  it('offers the deeplink on mobile and the plain URL elsewhere', () => {
    expect(renderShareSheet('https://u/l/abc', 'nimiqpay://x', true)).toContain('nimiqpay://x');
    expect(renderShareSheet('https://u/l/abc', 'nimiqpay://x', false)).toContain('https://u/l/abc');
  });

  it('adds no approval step — sharing is one action', () => {
    const html = renderShareSheet('https://u/l/abc', 'nimiqpay://x', false);
    expect(html).toContain('data-action="share"');
    expect(html).not.toContain('data-action="approve"');
  });
});

describe('theme default follows the host', () => {
  it('defaults to LIGHT even when the system prefers dark (Nimiq Pay is light)', () => {
    const store = new LocalThemeStore(new MemoryStore());
    expect(resolveTheme(store, true)).toBe('light');
    expect(resolveTheme(store, false)).toBe('light');
  });

  it('an explicit choice still overrides and persists', () => {
    const kv = new MemoryStore();
    const store = new LocalThemeStore(kv);
    store.set('dark');
    expect(resolveTheme(store, false)).toBe('dark');
    expect(resolveTheme(new LocalThemeStore(kv), true)).toBe('dark');
  });
});
