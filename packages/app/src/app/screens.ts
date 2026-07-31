/**
 * Screen rendering. Pure functions from view model → HTML, so every screen —
 * including each degraded state — is renderable in a test without a browser,
 * a wallet, or a network.
 *
 * Styling uses the design's token variables (.tka dark / .tkl light) so the
 * markup stays faithful to the design system rather than re-implementing it.
 */
import type { LedgerViewModel, LegView, RoundView } from '../state/ledger-state.js';
import type { Translator } from '../shell/i18n.js';

/** The four designed degraded states (PRD 6). None of them is an error page. */
export type Degraded =
  | { kind: 'declined' }
  | { kind: 'offline'; source: 'cache' | 'none' }
  | { kind: 'consensusLost' }
  | { kind: 'forked'; divergenceHint: string }
  | { kind: 'underfunded'; shortBy: bigint }
  /** GAP B: the wallet no longer offers the address this tab was joined with. */
  | { kind: 'accountSwitched'; joinedWith: string }
  | null;

export function nim(luna: bigint): string {
  const neg = luna < 0n;
  const abs = neg ? -luna : luna;
  const whole = abs / 100_000n;
  const frac = abs % 100_000n;
  const body = frac === 0n
    ? whole.toLocaleString('en-US')
    : `${whole.toLocaleString('en-US')}.${frac.toString().padStart(5, '0').replace(/0+$/, '')}`;
  return `${neg ? '−' : ''}${body}`;
}

export function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** A name for a member: the display label if we have one, else a short address. */
export function nameOf(address: string, names: Map<string, string>): string {
  return names.get(address) ?? shortAddr(address);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Blocks → "1h 58m", for the round expiry countdown (~1 block/second). */
export function countdown(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.max(0, seconds)}s`;
}

// --- degraded banners -------------------------------------------------------

/**
 * Every degraded state is a designed, plain-language state — never a spinner,
 * never a stack trace, never a dead end. A declined dialog in particular must
 * not look like a failure: nothing went wrong, the user simply said no.
 */
export function renderDegraded(d: Degraded, t: Translator): string {
  if (!d) return '';
  const banner = (tone: 'calm' | 'warn', title: string, body: string, action?: string): string => `
    <div class="banner ${tone}" role="status">
      <div class="banner-t">${esc(title)}</div>
      <div class="banner-b">${esc(body)}</div>
      ${action ? `<button class="banner-a" data-action="${action}">Try again</button>` : ''}
    </div>`;

  switch (d.kind) {
    case 'declined':
      return banner('calm', 'Nothing was sent', t.t('degraded.declined'), 'retry');
    case 'offline':
      return banner(
        'calm',
        d.source === 'cache' ? 'Offline — showing your last synced view' : 'Offline',
        d.source === 'cache'
          ? t.t('degraded.offline')
          : 'No cached copy of this ledger yet. Reconnect to load it.',
        'retry',
      );
    case 'consensusLost':
      return banner('warn', 'Reconnecting to the network', t.t('degraded.consensusLost'));
    case 'forked':
      return banner(
        'warn',
        'This ledger has diverged',
        `${t.t('degraded.forked')} ${d.divergenceHint}`,
      );
    case 'accountSwitched':
      // Never render an empty or broken ledger — name the address the tab was
      // joined with and give both ways forward.
      return `
    <div class="banner warn" role="status">
      <div class="banner-t">This tab belongs to a different address</div>
      <div class="banner-b">You joined it with <span class="mono">${esc(shortAddr(d.joinedWith))}</span>, which your wallet is not currently offering. Switch back to that address in Nimiq Pay and the tab returns exactly as it was — nothing has been lost.</div>
      <button class="banner-a" data-action="join-fresh">Join as a new member instead</button>
    </div>`;
    case 'underfunded':
      return banner(
        'warn',
        'Purse is short',
        `This leg needs ${nim(d.shortBy)} NIM more than the purse holds. The other transfers still go ahead — top up and this one follows.`,
        'topup',
      );
  }
}

// --- the round: partial states (GAP 2) --------------------------------------

function legRow(leg: LegView, names: Map<string, string>, t: Translator): string {
  const who = nameOf(leg.from, names);
  const to = nameOf(leg.to, names);
  const label: Record<LegView['status'], string> = {
    landed: t.t('round.landed'),
    sending: t.t('round.sending'),
    // Never "pending" without saying what it waits on.
    waiting: t.t('round.waitingOn', { name: who }),
    expired: 'Expired — rolls into the next round',
  };
  return `
    <div class="leg ${leg.status}">
      <span class="leg-w">${esc(who)} <span class="dim">→</span> ${esc(to)}</span>
      <span class="leg-a">${nim(leg.amount)}</span>
      <span class="leg-s">${esc(label[leg.status])}</span>
      ${leg.status === 'waiting' ? `<button class="nudge" data-action="nudge" data-who="${esc(leg.from)}">Nudge</button>` : ''}
    </div>`;
}

/**
 * A partial round is a normal state, shown honestly: what landed, what has not,
 * by name, with the validity window as a countdown. A creditor can nudge, which
 * opens the share sheet — mini apps have no push channel.
 */
export function renderRound(r: RoundView, names: Map<string, string>, t: Translator): string {
  const done = r.landedCount === r.totalCount;
  const expiry = r.expiresInSeconds === null ? '' : `<span class="expiry">${t.t('round.expiresIn', { time: countdown(r.expiresInSeconds) })}</span>`;
  return `
    <section class="round">
      <div class="round-h">
        <strong>Round ${r.round}</strong>
        <span class="dim">${r.landedCount} of ${r.totalCount} settled</span>
        ${r.expired ? '<span class="expiry warn">Window closed</span>' : expiry}
      </div>
      ${r.legs.map((l) => legRow(l, names, t)).join('')}
      ${
        r.expired
          ? `<p class="note">This round's two-hour window closed before everyone paid. It closes here — the legs that landed stay landed, and the rest roll into a fresh round against current balances.</p>`
          : done
            ? `<p class="note ok">Everyone has settled. Balances are back to zero.</p>`
            : `<p class="note">Legs land independently as each person opens Tally. Nobody is blocked on anyone else.</p>`
      }
    </section>`;
}

// --- the collapse: settlement preview ---------------------------------------

/**
 * The collapse — the screenshot that carries the whole idea: N obligations
 * become M transfers, and whoever nets to zero disappears from the round.
 */
export function renderPreview(vm: LedgerViewModel, names: Map<string, string>, t: Translator): string {
  const plan = vm.preview;
  if (!plan) return '';
  const obligationCount = vm.members.filter((m) => m.position !== 0n).length;
  const dropped = plan.participants.filter((p) => !plan.transfers.some((t2) => t2.from === p || t2.to === p));
  return `
    <section class="card collapse">
      <div class="collapse-h"><strong>${t.t('ledger.settleUp')}</strong><span class="dim">preview</span></div>
      <div class="collapse-n">
        <span class="big">${obligationCount}</span> in the round
        <span class="arrow">→</span>
        <span class="big amb">${plan.transfers.length}</span> transfer${plan.transfers.length === 1 ? '' : 's'}
      </div>
      ${plan.transfers
        .map(
          (tr) => `<div class="leg"><span class="leg-w">${esc(nameOf(tr.from, names))} <span class="dim">→</span> ${esc(nameOf(tr.to, names))}</span><span class="leg-a">${nim(tr.amount)}</span></div>`,
        )
        .join('')}
      ${dropped.length ? `<p class="note">${dropped.map((d) => esc(nameOf(d, names))).join(', ')} net${dropped.length === 1 ? 's' : ''} to zero — out of this round entirely.</p>` : ''}
      <button class="btn" data-action="call-tab">${t.t('ledger.callTab')}</button>
    </section>`;
}

// --- requests ---------------------------------------------------------------

export function renderRequests(vm: LedgerViewModel, names: Map<string, string>, t: Translator): string {
  if (vm.requestsForMe.length === 0) return '';
  return `
    <section class="card">
      <div class="collapse-h"><strong>Waiting on you</strong><span class="dim">${vm.requestsForMe.length}</span></div>
      ${vm.requestsForMe
        .map(
          (o) => `
        <div class="req">
          <div class="req-t">${esc(nameOf(o.creditor, names))} says you owe <strong>${nim(o.amount)} NIM</strong></div>
          ${o.memo ? `<div class="dim">${esc(o.memo)}</div>` : ''}
          <div class="req-a">
            <button class="btn sm" data-action="accept" data-id="${esc(o.proposeId)}">${t.t('obligation.accept')}</button>
            <button class="btn sm ghost" data-action="reject" data-id="${esc(o.proposeId)}">${t.t('obligation.reject')}</button>
          </div>
          <div class="dim sm">Accepting is one tap — no payment prompt. Nothing moves until a round settles.</div>
        </div>`,
        )
        .join('')}
    </section>`;
}

// --- reconciliation ---------------------------------------------------------

export interface ReconciliationRow {
  round: number;
  expectedRoot: string;
  onChainRoot: string | null;
  legsFound: number;
  legsExpected: number;
}

/**
 * Reconciliation: recompute each round's root locally and compare it to what the
 * anchors on chain actually say. A match is proof the history was not rewritten;
 * a mismatch is stated plainly rather than hidden.
 */
export function renderReconciliation(rows: ReconciliationRow[]): string {
  if (rows.length === 0) {
    return `<section class="card"><p class="note">No settled rounds yet. Once a round lands, its on-chain anchor can be checked here.</p></section>`;
  }
  return `
    <section class="card">
      <div class="collapse-h"><strong>Reconciliation</strong><span class="dim">local log vs the chain</span></div>
      ${rows
        .map((r) => {
          const complete = r.legsFound === r.legsExpected;
          const match = r.onChainRoot !== null && r.onChainRoot === r.expectedRoot && complete;
          return `
          <div class="rec ${match ? 'ok' : r.onChainRoot === null ? 'pending' : 'bad'}">
            <div class="rec-h"><strong>Round ${r.round}</strong><span>${match ? '✓ verified' : r.onChainRoot === null ? 'not yet anchored' : '✕ mismatch'}</span></div>
            <div class="mono">root ${esc(r.expectedRoot.slice(0, 12))}…</div>
            <div class="dim sm">${r.legsFound} of ${r.legsExpected} anchors found on chain${match ? ' — every root matches what the money says' : ''}</div>
          </div>`;
        })
        .join('')}
      <p class="note">Recomputed from your own signed log and checked against the chain. This needs no cooperation from Tally's relay — export the log and anyone can repeat it.</p>
    </section>`;
}

// --- home -------------------------------------------------------------------

export interface HomeOpts {
  showNetworkChip: boolean;
  canSettle: boolean;
  /** Membership as reconciled against the wallet's current addresses (GAP A/B). */
  membership: 'not-a-member' | 'active' | 'left' | 'account-switched';
  /** Purse balance in Luna once bound, else null. */
  purseBalance: bigint | null;
  purseAddress: string | null;
  /** Auto-settle spends from the purse; manual asks per leg. */
  mode: 'purse' | 'manual';
  busy: string | null;
}

/**
 * The account strip: whatever the user's next real step is. Joining, arming the
 * purse, topping it up, or emptying it. Withdraw-all is reachable from here on
 * every screen, which is a stated security property rather than a convenience.
 */
function renderAccountStrip(o: HomeOpts, t: Translator): string {
  if (o.membership === 'not-a-member') {
    return `<section class="card">
      <p class="note">You are viewing this tab read-only. Nothing has touched your wallet.</p>
      <button class="btn" data-action="join">Join this tab</button>
    </section>`;
  }
  if (o.membership !== 'active') return '';

  if (o.purseAddress === null) {
    return `<section class="card">
      <div class="collapse-h"><strong>${t.t('purse.title')}</strong><span class="dim">optional</span></div>
      <p class="note">Settling currently asks you to approve each payment. Arming the purse lets Tally pay your share with no prompt. It is an app-managed key in this browser, its balance is the only thing at risk, and you can empty it in one tap at any time.</p>
      <button class="btn" data-action="bind">${t.t('purse.sign')}</button>
      <button class="btn ghost" data-action="skip-purse">${t.t('purse.skip')}</button>
    </section>`;
  }

  const bal = o.purseBalance ?? 0n;
  return `<section class="card">
    <div class="collapse-h"><strong>Purse</strong><span class="dim">${o.mode === 'purse' ? 'auto-settle on' : 'manual'}</span></div>
    <div class="leg"><span class="leg-w">Balance</span><span class="leg-a">${nim(bal)} NIM</span></div>
    <div class="row">
      <button class="btn sm" data-action="fund">Top up</button>
      <button class="btn sm ghost" data-action="withdraw">Withdraw all</button>
    </div>
    ${bal === 0n ? '<p class="note">Empty. Top up and your share settles without a prompt.</p>' : ''}
  </section>`;
}

/**
 * A tab with one person in it is not a tab. An obligation needs a debtor and a
 * creditor, so with no other members there is nobody to owe and "add an expense"
 * is the wrong instruction. Three distinct states, never one.
 */
function renderEmptyState(vm: LedgerViewModel, o: HomeOpts): string {
  if (vm.preview || vm.openRound || vm.requestsForMe.length > 0) return ''; // a real ledger
  const others = vm.members.filter((m) => m.address !== vm.myAddressForSettle).length;

  if (o.membership === 'active' && others === 0) {
    return `<section class="card">
      <div class="collapse-h"><strong>Invite someone</strong></div>
      <p class="note">A tab needs at least two people. Invite someone and start putting things on it.</p>
      <button class="btn" data-action="invite">Share the invite link</button>
    </section>`;
  }
  if (o.membership === 'active') {
    return `<section class="card">
      <p class="note">Nothing on this tab yet. Add the first expense and it will start netting.</p>
    </section>`;
  }
  return '';
}

export function renderHome(
  vm: LedgerViewModel,
  names: Map<string, string>,
  t: Translator,
  degraded: Degraded,
  opts: HomeOpts,
): string {
  // A non-member has no position, so "0 NIM, settled up" would be a lie. Show
  // the tab's size instead, which is what an onlooker actually wants to know.
  const onlooker = vm.myPosition === null;
  const owed = vm.myPosition ?? 0n;
  const owing = vm.members.filter((m) => m.position !== 0n).length;
  const heading = onlooker
    ? `${vm.members.length} people, ${owing} with something outstanding`
    : owed > 0n
      ? t.t('ledger.youAreOwed')
      : owed < 0n
        ? t.t('ledger.youOwe')
        : t.t('ledger.settled');
  return `
    <div class="wrap">
      <header class="hdr">
        <strong class="brand">${esc(vm.name ?? 'Tally')}</strong>
        ${opts.showNetworkChip ? `<span class="chip">${t.t('network.testnet')}</span>` : ''}
        <button class="tog" data-action="theme">◐</button>
      </header>
      ${renderDegraded(degraded, t)}
      <section class="hero">
        <div class="pos">${onlooker ? nim(vm.members.reduce((a, m) => (m.position > 0n ? a + m.position : a), 0n)) : nim(owed < 0n ? -owed : owed)}<span class="unit"> NIM</span></div>
        <div class="sub">${esc(onlooker ? `outstanding across ${heading}` : heading)}</div>
      </section>
      ${opts.busy ? `<div class="banner calm" role="status"><div class="banner-t">${esc(opts.busy)}</div></div>` : ''}
      ${renderEmptyState(vm, opts)}
      ${renderRequests(vm, names, t)}
      ${vm.openRound ? renderRound(vm.openRound, names, t) : opts.canSettle ? renderPreview(vm, names, t) : ''}
      ${vm.openRound && vm.openRound.legs.some((l) => l.status === 'waiting' && l.from === vm.myAddressForSettle) ? `<button class="btn" data-action="settle">${opts.mode === 'purse' ? 'Settle my share' : 'Settle my share (1 approval per payment)'}</button>` : ''}
      ${renderAccountStrip(opts, t)}
      <div class="actions">
        ${
          opts.membership === 'active' && vm.members.filter((m) => m.address !== vm.myAddressForSettle).length > 0
            ? `<button class="btn" data-action="add">${t.t('obligation.add')}</button>`
            : ''
        }
        <button class="btn ghost" data-action="invite">Invite someone</button>
      </div>
    </div>`;
}

/**
 * GAP D — the invite link is a capability. Anyone holding the URL can read the
 * whole tab from the relay; there is no access control beyond knowing the
 * 128-bit id. That is the right trade for a 2-to-12 person tab (an approval step
 * would wreck the 60-second onboarding target for a threat model that does not
 * warrant it), but it must be DISCLOSED at the moment of sharing rather than
 * discovered later.
 */
export const INVITE_DISCLOSURE =
  'Anyone with this link can see this tab — its members, expenses and settlements. Share it only with the people in it.';

export function renderShareSheet(inviteUrl: string, deeplinkUrl: string, isMobile: boolean): string {
  const primary = isMobile ? deeplinkUrl : inviteUrl;
  return `
    <section class="card">
      <div class="collapse-h"><strong>Invite to this tab</strong></div>
      <div class="mono" style="word-break:break-all">${esc(primary)}</div>
      <p class="note">${esc(INVITE_DISCLOSURE)}</p>
      <button class="btn" data-action="share" data-url="${esc(primary)}">Share link</button>
    </section>`;
}

export interface KnownTab {
  ledgerId: string;
  name: string | null;
}

/**
 * The bare origin inside Nimiq Pay. This is the Demo URL, so it has to say what
 * Tally is and get someone to a populated ledger immediately. An empty solo tab
 * is the wrong first impression: the strongest thing this product does is the
 * collapse, and that needs data to show.
 */
export function renderEntry(myTabs: KnownTab[], t: Translator): string {
  return `
    <div class="wrap entry">
      <header class="hdr">
        <strong class="brand">${esc(t.t('app.name'))}</strong>
        <button class="tog" data-action="theme">◐</button>
      </header>
      <div class="entry-body">
        <div class="mark" aria-hidden="true">|||</div>
        <h1 class="entry-h">Keep a running tab with your people.</h1>
        <p class="entry-s">Debts between friends net down to the fewest possible payments, then clear in NIM.</p>

        ${
          myTabs.length
            ? `<section class="card">
                <div class="collapse-h"><strong>Your tabs</strong></div>
                ${myTabs
                  .map(
                    (tab) =>
                      `<button class="tab-row" data-action="open-tab" data-id="${esc(tab.ledgerId)}">${esc(tab.name ?? 'Untitled tab')}<span class="dim">open</span></button>`,
                  )
                  .join('')}
              </section>`
            : ''
        }

        <button class="btn" data-action="example">See a live example</button>
        <button class="btn ghost" data-action="start-tab">Start a tab</button>
        <p class="note">The example is a real ledger with four people and five debts in it, read-only. Nothing touches your wallet until you choose to join something.</p>
      </div>
    </div>`;
}
