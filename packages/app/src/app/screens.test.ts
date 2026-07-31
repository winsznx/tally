import { describe, expect, it } from 'vitest';
import { Translator } from '../shell/i18n.js';
import type { LedgerViewModel, RoundView } from '../state/ledger-state.js';
import {
  countdown,
  nim,
  renderDegraded,
  renderEntry,
  renderHome,
  renderReconciliation,
  renderRound,
  type Degraded,
} from './screens.js';

const t = new Translator('en');
const homeOpts = (over: Partial<Parameters<typeof renderHome>[4]> = {}): Parameters<typeof renderHome>[4] => ({
  showNetworkChip: true,
  canSettle: true,
  membership: 'active',
  purseBalance: null,
  purseAddress: null,
  mode: 'manual',
  busy: null,
  ...over,
});
const names = new Map([
  ['aa'.repeat(20), 'Ada'],
  ['bb'.repeat(20), 'Bo'],
  ['dd'.repeat(20), 'Dee'],
]);
const ADA = 'aa'.repeat(20);
const BO = 'bb'.repeat(20);
const DEE = 'dd'.repeat(20);

describe('formatting', () => {
  it('formats Luna as NIM without floats', () => {
    expect(nim(150_000_000n)).toBe('1,500');
    expect(nim(100_000n)).toBe('1');
    expect(nim(150_000n)).toBe('1.5');
    expect(nim(-30_000_000n)).toBe('−300');
  });
  it('formats the expiry countdown', () => {
    expect(countdown(7100)).toBe('1h 58m');
    expect(countdown(600)).toBe('10m');
    expect(countdown(45)).toBe('45s');
  });
});

describe('GAP 2 — partial round states', () => {
  const round: RoundView = {
    round: 1,
    anchorHeight: 41200,
    mode: 'minimal',
    legs: [
      { from: ADA, to: DEE, amount: 120_000_000n, status: 'landed', waitingOn: null, txHash: 'aa' },
      { from: BO, to: DEE, amount: 30_000_000n, status: 'waiting', waitingOn: BO, txHash: null },
    ],
    landedCount: 1,
    totalCount: 2,
    expiresInSeconds: 7100,
    expired: false,
  };

  it('names who it is waiting on, never a bare "pending"', () => {
    const html = renderRound(round, names, t);
    expect(html).toContain('Waiting on Bo to open Tally');
    expect(html).not.toMatch(/>\s*Processing\s*</);
    expect(html).toContain('1 of 2 settled');
  });

  it('shows what landed and what has not, per counterparty, with amounts', () => {
    const html = renderRound(round, names, t);
    expect(html).toContain('Ada <span class="dim">→</span> Dee');
    expect(html).toContain('1,200');
    expect(html).toContain('300');
    expect(html).toContain('Settled');
  });

  it('shows the validity window as a countdown in hours', () => {
    expect(renderRound(round, names, t)).toContain('Expires in 1h 58m');
  });

  it('offers a nudge on a waiting leg (share sheet, not a notification)', () => {
    const html = renderRound(round, names, t);
    expect(html).toContain('data-action="nudge"');
    expect(html).toContain(`data-who="${BO}"`);
  });

  it('explains expiry in one line instead of letting it just happen', () => {
    const expired: RoundView = {
      ...round,
      expired: true,
      expiresInSeconds: 0,
      legs: round.legs.map((l) => (l.status === 'waiting' ? { ...l, status: 'expired' as const } : l)),
    };
    const html = renderRound(expired, names, t);
    expect(html).toContain('Window closed');
    expect(html).toContain('roll into a fresh round');
    expect(html).toContain('legs that landed stay landed');
  });

  it('says so plainly when everyone has settled', () => {
    const done: RoundView = {
      ...round,
      landedCount: 2,
      legs: round.legs.map((l) => ({ ...l, status: 'landed' as const })),
    };
    expect(renderRound(done, names, t)).toContain('Everyone has settled');
  });
});

describe('degraded states — all four, none an error page', () => {
  const cases: [Degraded, string][] = [
    [{ kind: 'declined' }, 'Nothing was sent'],
    [{ kind: 'offline', source: 'cache' }, 'last synced view'],
    [{ kind: 'consensusLost' }, 'Reconnecting to the network'],
    [{ kind: 'forked', divergenceHint: 'since round 2' }, 'diverged'],
  ];

  for (const [state, expected] of cases) {
    it(`${state?.kind} renders a designed state containing "${expected}"`, () => {
      const html = renderDegraded(state, t);
      expect(html).toContain(expected);
      expect(html).toContain('role="status"');
      // never a raw failure
      expect(html.toLowerCase()).not.toContain('error');
      expect(html.toLowerCase()).not.toContain('failed');
    });
  }

  it('a declined dialog reads as a normal outcome and offers a retry', () => {
    const html = renderDegraded({ kind: 'declined' }, t);
    expect(html).toContain('calm');
    expect(html).toContain('nothing was sent');
    expect(html).toContain('data-action="retry"');
  });

  it('an underfunded purse skips one leg and says the others proceed', () => {
    const html = renderDegraded({ kind: 'underfunded', shortBy: 50_000_000n }, t);
    expect(html).toContain('500');
    expect(html).toContain('other transfers still go ahead');
    expect(html).toContain('data-action="topup"');
  });

  it('renders nothing when healthy', () => {
    expect(renderDegraded(null, t)).toBe('');
  });
});

describe('reconciliation', () => {
  it('shows a verified match when the recomputed root equals the anchor', () => {
    const html = renderReconciliation([
      { round: 1, expectedRoot: 'abcdef0123456789', onChainRoot: 'abcdef0123456789', legsFound: 2, legsExpected: 2 },
    ]);
    expect(html).toContain('✓ verified');
    expect(html).toContain('every root matches what the money says');
  });

  it('states a mismatch plainly rather than hiding it', () => {
    const html = renderReconciliation([
      { round: 1, expectedRoot: 'aaaa', onChainRoot: 'bbbb', legsFound: 1, legsExpected: 2 },
    ]);
    expect(html).toContain('✕ mismatch');
  });

  it('distinguishes not-yet-anchored from a mismatch', () => {
    const html = renderReconciliation([
      { round: 2, expectedRoot: 'aaaa', onChainRoot: null, legsFound: 0, legsExpected: 2 },
    ]);
    expect(html).toContain('not yet anchored');
    expect(html).not.toContain('mismatch');
  });
});

describe('home', () => {
  const vm: LedgerViewModel = {
    name: 'Trip',
    genesisHash: 'ff'.repeat(32),
    members: [
      { address: ADA, position: -120_000_000n },
      { address: DEE, position: 120_000_000n },
    ],
    myPosition: 120_000_000n,
    requestsForMe: [],
    awaitingOthers: [],
    preview: null,
    openRound: null,
    myAddressForSettle: null,
    ignoredCount: 0,
  };

  it('leads with the net position and shows the testnet chip only on testnet', () => {
    const html = renderHome(vm, names, t, null, homeOpts({ showNetworkChip: true }));
    expect(html).toContain('1,200');
    expect(html).toContain('You are owed');
    expect(html).toContain('Testnet');
    expect(renderHome(vm, names, t, null, homeOpts({ showNetworkChip: false }))).not.toContain('Testnet');
  });

  it('shows a degraded banner above the ledger without hiding it', () => {
    const html = renderHome(vm, names, t, { kind: 'offline', source: 'cache' }, homeOpts({ showNetworkChip: true }));
    expect(html).toContain('last synced view');
    expect(html).toContain('1,200'); // the ledger still renders underneath
  });
});

describe('the account strip surfaces the next real action', () => {
  // Two members: "add expense" is only correct once there is somebody to owe.
  const base: LedgerViewModel = {
    name: 'Trip', genesisHash: 'ff'.repeat(32),
    members: [{ address: ADA, position: -120_000_000n }, { address: DEE, position: 120_000_000n }],
    myPosition: -120_000_000n, requestsForMe: [], awaitingOthers: [],
    preview: null, openRound: null, myAddressForSettle: ADA, ignoredCount: 0,
  };

  it('a non-member is read-only and is offered a join, never an add', () => {
    const html = renderHome(base, names, t, null, homeOpts({ membership: 'not-a-member' }));
    expect(html).toContain('data-action="join"');
    expect(html).toContain('read-only');
    expect(html).toContain('Nothing has touched your wallet');
    expect(html).not.toContain('data-action="add"');
  });

  it('a member without a purse is offered binding, and told what it costs', () => {
    const html = renderHome(base, names, t, null, homeOpts({ membership: 'active', purseAddress: null }));
    expect(html).toContain('data-action="bind"');
    expect(html).toContain('data-action="skip-purse"');
    expect(html).toContain('app-managed key');
    expect(html).toContain('balance is the only thing at risk');
    expect(html).toContain('data-action="add"');
  });

  it('a bound purse shows its balance with top-up and withdraw-all always reachable', () => {
    const html = renderHome(base, names, t, null,
      homeOpts({ membership: 'active', purseAddress: 'aa'.repeat(20), purseBalance: 50_000_000n, mode: 'purse' }));
    expect(html).toContain('500'); // balance in NIM
    expect(html).toContain('data-action="fund"');
    expect(html).toContain('data-action="withdraw"');
    expect(html).toContain('auto-settle on');
  });

  it('offers settle only when I have a waiting leg, and labels the dialog cost', () => {
    const withMyLeg: LedgerViewModel = {
      ...base,
      openRound: {
        round: 1, anchorHeight: 41200, mode: 'minimal',
        legs: [{ from: ADA, to: DEE, amount: 120_000_000n, status: 'waiting', waitingOn: ADA, txHash: null }],
        landedCount: 0, totalCount: 1, expiresInSeconds: 7000, expired: false,
      },
    };
    const purseMode = renderHome(withMyLeg, names, t, null, homeOpts({ mode: 'purse', purseAddress: 'aa'.repeat(20) }));
    expect(purseMode).toContain('data-action="settle"');
    expect(purseMode).toContain('Settle my share');
    expect(purseMode).not.toContain('approval per payment');

    const manualMode = renderHome(withMyLeg, names, t, null, homeOpts({ mode: 'manual', purseAddress: 'aa'.repeat(20) }));
    expect(manualMode).toContain('1 approval per payment');

    // somebody else's leg is not mine to pay
    const theirLeg: LedgerViewModel = {
      ...withMyLeg,
      openRound: { ...withMyLeg.openRound!, legs: [{ ...withMyLeg.openRound!.legs[0]!, from: BO, waitingOn: BO }] },
    };
    expect(renderHome(theirLeg, names, t, null, homeOpts())).not.toContain('data-action="settle"');
  });

  it('shows a busy label while an action is in flight', () => {
    expect(renderHome(base, names, t, null, homeOpts({ busy: 'Settling' }))).toContain('Settling');
  });
});

describe('the bare origin gets a real entry screen', () => {
  it('leads with the live example, not an empty tab', () => {
    const html = renderEntry([], t);
    expect(html).toContain('data-action="example"');
    expect(html).toContain('See a live example');
    expect(html).toContain('data-action="start-tab"');
    // the example is primary, start-tab secondary
    expect(html.indexOf('data-action="example"')).toBeLessThan(html.indexOf('data-action="start-tab"'));
    expect(html).toContain('Nothing touches your wallet');
    // never the empty-solo contradiction
    expect(html).not.toContain('Nothing to settle yet');
    expect(html).not.toContain('data-action="join"');
  });

  it('lists tabs I am already in above both actions', () => {
    const html = renderEntry([{ ledgerId: 'abc', name: 'Lisbon trip' }], t);
    expect(html).toContain('Lisbon trip');
    expect(html).toContain('data-action="open-tab"');
    expect(html.indexOf('Lisbon trip')).toBeLessThan(html.indexOf('data-action="example"'));
  });
});

describe('the solo tab tells you to invite, not to add an expense', () => {
  const solo: LedgerViewModel = {
    name: 'New tab', genesisHash: 'ff'.repeat(32),
    members: [{ address: ADA, position: 0n }],
    myPosition: 0n, requestsForMe: [], awaitingOthers: [],
    preview: null, openRound: null, myAddressForSettle: ADA, ignoredCount: 0,
  };

  it('makes sharing the invite the primary action when I am alone', () => {
    const html = renderHome(solo, names, t, null, homeOpts({ membership: 'active' }));
    expect(html).toContain('A tab needs at least two people');
    expect(html).toContain('Share the invite link');
    // "add an expense" is wrong with nobody to owe
    expect(html).not.toContain('data-action="add"');
    expect(html).not.toContain('Nothing to settle yet');
  });

  it('offers add expense once somebody else is in the tab', () => {
    const withBo: LedgerViewModel = { ...solo, members: [...solo.members, { address: BO, position: 0n }] };
    const html = renderHome(withBo, names, t, null, homeOpts({ membership: 'active' }));
    expect(html).toContain('data-action="add"');
    expect(html).toContain('Add the first expense');
    expect(html).not.toContain('A tab needs at least two people');
  });

  it('never shows a read-only notice and an add prompt at the same time', () => {
    const html = renderHome(solo, names, t, null, homeOpts({ membership: 'not-a-member' }));
    expect(html).toContain('read-only');
    expect(html).not.toContain('Add the first expense');
    expect(html).not.toContain('A tab needs at least two people');
  });
});

describe('an onlooker sees the tab, not a fake personal position', () => {
  it('never claims "settled up" to somebody with no position in the tab', () => {
    const vm: LedgerViewModel = {
      name: 'Lisbon trip (live example)', genesisHash: 'ff'.repeat(32),
      members: [
        { address: ADA, position: -120_000_000n },
        { address: BO, position: -30_000_000n },
        { address: DEE, position: 150_000_000n },
      ],
      myPosition: null, requestsForMe: [], awaitingOthers: [],
      preview: null, openRound: null, myAddressForSettle: null, ignoredCount: 0,
    };
    const html = renderHome(vm, names, t, null, homeOpts({ membership: 'not-a-member' }));
    expect(html).not.toContain('Settled up');
    expect(html).toContain('3 people');
    expect(html).toContain('1,500'); // total outstanding
    expect(html).toContain('read-only');
  });
});
