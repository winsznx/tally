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
  if (!plan) {
    return `<section class="card"><p class="note">Nothing to settle yet. Add an expense to start the tab.</p></section>`;
  }
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

export function renderHome(
  vm: LedgerViewModel,
  names: Map<string, string>,
  t: Translator,
  degraded: Degraded,
  opts: { showNetworkChip: boolean; canSettle: boolean },
): string {
  const owed = vm.myPosition ?? 0n;
  const heading = owed > 0n ? t.t('ledger.youAreOwed') : owed < 0n ? t.t('ledger.youOwe') : t.t('ledger.settled');
  return `
    <div class="wrap">
      <header class="hdr">
        <strong class="brand">${esc(vm.name ?? 'Tally')}</strong>
        ${opts.showNetworkChip ? `<span class="chip">${t.t('network.testnet')}</span>` : ''}
        <button class="tog" data-action="theme">◐</button>
      </header>
      ${renderDegraded(degraded, t)}
      <section class="hero">
        <div class="pos">${nim(owed < 0n ? -owed : owed)}<span class="unit"> NIM</span></div>
        <div class="sub">${esc(heading)}</div>
      </section>
      ${renderRequests(vm, names, t)}
      ${vm.openRound ? renderRound(vm.openRound, names, t) : opts.canSettle ? renderPreview(vm, names, t) : ''}
      <div class="actions">
        <button class="btn" data-action="add">${t.t('obligation.add')}</button>
      </div>
    </div>`;
}
