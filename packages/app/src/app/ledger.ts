/**
 * Ledger controller — the actions the UI performs, over the derived state.
 *
 * The log is truth. Every action authors a signed entry, appends it locally and
 * to the relay, and re-derives state; nothing is stored twice. Reads tolerate a
 * dead relay by falling back to the cache, and every entry from either source is
 * re-verified before it reaches state.
 */
import { PublicKey } from '@nimiq/core';
import { GENESIS_ROOT, computeRoundRoot, encodeAnchor, ledgerTagFromGenesisHash } from '@tally/core/anchor';
import { computePlan, type NettingMode, type Obligation, type SettlementPlan } from '@tally/core/netting';
import { derivedAnchorHeight, obligationLogRoot, replayState, type LogEntry } from '@tally/core/log';
import { buildSettlementLeg } from '@tally/core/tx';
import type { EntryCache } from '../adapters/cache.js';
import { buildManualLegParams, chooseIdempotencyStrategy, type SettlementMode } from '../adapters/settlement.js';
import type { ChainAdapter, NetworkId, ProviderAdapter, RelayAdapter } from '../adapters/types.js';
import { deriveViewModel, ingestEntries, type LedgerViewModel, type ObservedLeg } from '../state/ledger-state.js';
import { EntryAuthor, toRelayRecord, type Identity } from './session.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The purse address a member pays FROM.
 *
 * Netting runs over ACCOUNT addresses — that is who owes whom. But the money
 * leaves the payer's PURSE, which is a different key. So when a plan transfer is
 * turned into a transaction, the sender is swapped to the payer's purse while
 * the recipient stays the creditor's account (they are paid into their real
 * wallet). Every member's purse public key is published in their MEMBER_JOIN,
 * so any device can compute any member's purse address — which is also how
 * on-chain settlements are matched back to plan legs.
 */
export function purseAddressOf(pursePublicKeyHex: string): string {
  return bytesToHex(PublicKey.deserialize(hexToBytes(pursePublicKeyHex)).toAddress().serialize());
}

export type SyncSource = 'relay' | 'cache' | 'none';

export interface LedgerDeps {
  relay: RelayAdapter;
  cache: EntryCache;
  chain: ChainAdapter;
  provider: ProviderAdapter;
  network: NetworkId;
}

export interface SettleOutcome {
  legIndex: number;
  broadcast: boolean;
  declined: boolean;
  txHash: string | null;
  error: string | null;
}

export class Ledger {
  #entries: LogEntry[] = [];
  #author: EntryAuthor | undefined;
  #source: SyncSource = 'none';
  #observedLegs: ObservedLeg[] = [];

  constructor(
    readonly ledgerId: string,
    private readonly deps: LedgerDeps,
    private identity: Identity | null = null,
  ) {
    if (identity) this.#author = new EntryAuthor(identity, this.#entries);
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }
  get syncSource(): SyncSource {
    return this.#source;
  }
  get myAddress(): string | null {
    return this.identity?.accountAddress ?? null;
  }

  setIdentity(identity: Identity): void {
    this.identity = identity;
    this.#author = new EntryAuthor(identity, this.#entries);
  }

  /**
   * Pull from the relay; on failure fall back to the cache so a cold open with
   * a dead relay renders the ledger read-only instead of an error page.
   */
  async sync(): Promise<SyncSource> {
    let raws: string[] | null = null;
    try {
      const rows = await this.deps.relay.getSince(this.ledgerId, null);
      raws = rows.map((r) => r.entryJson);
      this.#source = 'relay';
    } catch {
      raws = this.deps.cache.load(this.ledgerId);
      this.#source = raws.length ? 'cache' : 'none';
    }
    this.#entries = ingestEntries(raws ?? []); // re-verify everything
    if (this.#source === 'relay') this.deps.cache.save(this.ledgerId, this.#entries.map((e) => JSON.stringify(e)));
    this.#author?.sync(this.#entries);
    return this.#source;
  }

  /** Load straight from cache without touching the network (instant cold open). */
  loadFromCache(): void {
    this.#entries = ingestEntries(this.deps.cache.load(this.ledgerId));
    this.#source = this.#entries.length ? 'cache' : 'none';
    this.#author?.sync(this.#entries);
  }

  view(headHeight: number | null, nowMs: number): LedgerViewModel {
    return deriveViewModel({
      entries: this.#entries,
      myAddress: this.myAddress,
      headHeight,
      nowMs,
      observedLegs: this.#observedLegs,
    });
  }

  #requireAuthor(): EntryAuthor {
    if (!this.#author) throw new Error('join the ledger before authoring entries');
    return this.#author;
  }

  /** Append locally + to the relay. A relay failure does not lose the entry. */
  async #commit(entry: LogEntry): Promise<void> {
    this.#entries = [...this.#entries, entry];
    this.deps.cache.save(this.ledgerId, this.#entries.map((e) => JSON.stringify(e)));
    try {
      await this.deps.relay.append(this.ledgerId, [JSON.stringify(toRelayRecord(entry))]);
    } catch {
      // Queued in the cache; the next successful sync re-sends it.
    }
  }

  async openLedger(name: string): Promise<LogEntry> {
    const entry = this.#requireAuthor().author('LEDGER_OPEN', { name });
    await this.#commit(entry);
    return entry;
  }

  async join(): Promise<LogEntry> {
    const entry = this.#requireAuthor().author('MEMBER_JOIN', {});
    await this.#commit(entry);
    return entry;
  }

  /** Step 1 — add an obligation. Zero dialogs: the purse signs it. */
  async propose(debtor: string, creditor: string, amountLuna: bigint, memo?: string): Promise<LogEntry> {
    const entry = this.#requireAuthor().author('OBLIGATION_PROPOSE', {
      debtor,
      creditor,
      amount: amountLuna.toString(),
      ...(memo ? { memo } : {}),
    });
    await this.#commit(entry);
    return entry;
  }

  /**
   * Step 1 — accept. One tap, zero dialogs. Records the observed block height so
   * a later ROUND_OPEN can derive its anchor height from the log (GAP 1).
   */
  async accept(proposeId: string): Promise<LogEntry> {
    const observedHeight = await this.#safeHeadHeight();
    const entry = this.#requireAuthor().author('OBLIGATION_ACCEPT', { proposeId, observedHeight });
    await this.#commit(entry);
    return entry;
  }

  /** Step 1 — reject. The edge becomes CONTESTED; it is never silently deleted. */
  async reject(proposeId: string, reason?: string): Promise<LogEntry> {
    const entry = this.#requireAuthor().author('OBLIGATION_REJECT', {
      proposeId,
      ...(reason ? { reason } : {}),
    });
    await this.#commit(entry);
    return entry;
  }

  async #safeHeadHeight(): Promise<number> {
    try {
      return await this.deps.chain.headHeight();
    } catch {
      // Chain unreachable: fall back to the last height the log itself recorded,
      // so an accept still works offline and stays deterministic.
      const state = replayState(this.#entries);
      const heights = state.obligations
        .map((o) => o.acceptObservedHeight)
        .filter((h): h is number => h !== null);
      return heights.length ? Math.max(...heights) : 1;
    }
  }

  /** Step 2 — the settlement preview. Pure: same log ⇒ same plan on every device. */
  preview(mode: NettingMode = 'minimal'): SettlementPlan | null {
    const state = replayState(this.#entries);
    if (state.acceptedPending.length === 0) return null;
    return computePlan(
      state.members.map((m) => m.address),
      state.acceptedPending.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
      mode,
    );
  }

  /**
   * Step 3 — open a round. The anchor height is DERIVED from the log, and the
   * nonce is content-derived, so every device that opens this round produces a
   * byte-identical entry that collapses on arrival (GAP 1).
   */
  async openRound(mode: NettingMode = 'minimal'): Promise<LogEntry> {
    const state = replayState(this.#entries);
    if (state.openRound) throw new Error(`round ${state.openRound.round} is already open`);
    const accepted = state.obligations.filter((o) => o.status === 'ACCEPTED');
    if (accepted.length === 0) throw new Error('nothing to settle');
    const entry = this.#requireAuthor().author('ROUND_OPEN', {
      round: state.lastClosedRound + 1,
      anchorHeight: derivedAnchorHeight(accepted),
      mode,
      // Pin what this round settles. Two devices with the same accepted set
      // produce the identical payload (and so the identical entry, GAP 1); a
      // device with a different view produces a different round rather than
      // silently mutating this one.
      participants: state.members.map((m) => m.address).sort(),
      consumed: accepted.map((o) => o.proposeId).sort(),
    });
    await this.#commit(entry);
    return entry;
  }

  /**
   * The round's commitment root, recomputed by chaining from genesis so it never
   * depends on stored state that could drift.
   */
  roundRoot(): Uint8Array | null {
    const state = replayState(this.#entries);
    const open = state.openRound;
    if (!open) return null;
    // The round's OWN participant set, pinned when it opened — never the live
    // member list, which a mid-round join would change under an anchored root.
    const members = open.participants;

    let root = GENESIS_ROOT;
    for (let r = 1; r <= open.round; r++) {
      const inRound = state.obligations.filter((o) => o.round === r);
      if (inRound.length === 0) continue;
      const plan = computePlan(
        members,
        inRound.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
        open.mode,
      );
      const acceptIds = inRound.map((o) => o.acceptId).filter((id): id is string => id !== null);
      root = computeRoundRoot(root, obligationLogRoot(acceptIds), plan);
    }
    return root;
  }

  /** The anchor string for one leg of the open round (PRD 3.3). */
  anchorFor(legIndex1Based: number): string | null {
    const state = replayState(this.#entries);
    const open = state.openRound;
    const root = this.roundRoot();
    if (!open || !root || !state.genesisHash) return null;
    const inRound = state.obligations.filter((o) => o.round === open.round);
    const plan = computePlan(
      open.participants,
      inRound.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
      open.mode,
    );
    return encodeAnchor({
      ledgerTag: ledgerTagFromGenesisHash(hexToBytes(state.genesisHash)),
      round: open.round,
      index: legIndex1Based,
      count: plan.transfers.length,
      root,
    });
  }

  /**
   * Step 3 — settle MY legs of the open round.
   *
   * Both modes build the identical payload; only the signer differs:
   *   purse  — the purse signs locally and broadcasts. Zero dialogs.
   *   manual — Nimiq Pay signs, one dialog per leg, with fee and
   *            validityStartHeight passed EXPLICITLY so the bytes stay
   *            deterministic if the wallet honours them (Test M).
   *
   * validityStartHeight ALWAYS comes from the round's ROUND_OPEN entry, never
   * from the chain at broadcast time — that is what stops two devices from
   * producing two real payments.
   */
  async settleMyLegs(mode: SettlementMode, manualHonoursExplicitFields = true): Promise<SettleOutcome[]> {
    const state = replayState(this.#entries);
    const open = state.openRound;
    if (!open) throw new Error('no open round');
    const me = this.myAddress;
    if (!me) throw new Error('not a member');

    const inRound = state.obligations.filter((o) => o.round === open.round);
    const plan = computePlan(
      open.participants,
      inRound.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
      open.mode,
    );
    const root = this.roundRoot();
    if (!root || !state.genesisHash) throw new Error('cannot compute the round root');

    const strategy = chooseIdempotencyStrategy(mode, manualHonoursExplicitFields);
    const outcomes: SettleOutcome[] = [];

    for (let i = 0; i < plan.transfers.length; i++) {
      const leg = plan.transfers[i] as SettlementPlan['transfers'][number];
      if (leg.from !== me) continue; // a purse can only ever pay its own leg
      const legIndex = i + 1;
      const anchor = this.anchorFor(legIndex) as string;

      // Under the `locked` strategy a leg already seen in flight is not re-sent.
      if (strategy === 'locked' && this.#observedLegs.some((o) => o.from === leg.from && o.to === leg.to && o.amount === leg.amount)) {
        outcomes.push({ legIndex, broadcast: false, declined: false, txHash: null, error: 'already in flight' });
        continue;
      }

      if (mode === 'purse') {
        if (!this.identity) throw new Error('no purse');
        try {
          // The money leaves my PURSE, not my account — swap the sender for the
          // tx while the plan (and therefore the anchor root) keeps account
          // addresses. Recipients are paid into their real wallet.
          const myPurse = purseAddressOf(bytesToHex(this.identity.purse.publicKey.serialize()));
          const paymentPlan: SettlementPlan = {
            ...plan,
            transfers: plan.transfers.map((t) => (t.from === me ? { ...t, from: myPurse } : t)),
          };
          const built = buildSettlementLeg({
            purse: this.identity.purse,
            plan: paymentPlan,
            index: legIndex,
            genesisHash: state.genesisHash,
            roundRoot: root,
            roundContext: { round: open.round, anchorHeight: open.anchorHeight },
            networkId: this.deps.network,
          });
          const { hash } = await this.deps.chain.broadcast(built.serializedHex);
          outcomes.push({ legIndex, broadcast: true, declined: false, txHash: hash, error: null });
        } catch (e) {
          outcomes.push({ legIndex, broadcast: false, declined: false, txHash: null, error: msg(e) });
        }
      } else {
        const params = buildManualLegParams({
          recipient: leg.to,
          value: leg.amount,
          anchor,
          anchorHeight: open.anchorHeight,
        });
        const res = await this.deps.provider.sendBasicTransactionWithData(params);
        if (res.kind === 'ok') {
          outcomes.push({ legIndex, broadcast: true, declined: false, txHash: res.value.hash, error: null });
        } else if (res.kind === 'declined') {
          // Declining is a normal outcome, not a failure.
          outcomes.push({ legIndex, broadcast: false, declined: true, txHash: null, error: null });
        } else {
          outcomes.push({ legIndex, broadcast: false, declined: false, txHash: null, error: res.message });
        }
      }
    }
    return outcomes;
  }

  /** Record on-chain observations so partial-round status can be derived (GAP 2). */
  setObservedLegs(legs: ObservedLeg[]): void {
    this.#observedLegs = legs;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
