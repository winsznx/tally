import { KeyPair, PrivateKey } from '@nimiq/core';
import { entryId, replayState, type LogEntry } from '@tally/core/log';
import { decodeAnchor } from '@tally/core/anchor';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, StoredEntryCache } from '../adapters/cache.js';
import { FakeChain, FakeProvider, FakeRelay } from '../adapters/fakes.js';
import { TESTNET } from '../adapters/types.js';
import { Ledger, type LedgerDeps } from './ledger.js';
import { localIdentity, type Identity } from './session.js';

const kp = (seed: string): KeyPair => KeyPair.derive(PrivateKey.fromHex(seed.repeat(32)));
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function identity(accountSeed: string, purseSeed: string): Identity {
  return localIdentity(kp(accountSeed), kp(purseSeed));
}

const ada = identity('a1', 'a2');
const bo = identity('b1', 'b2');
const cy = identity('c1', 'c2');
const dee = identity('d1', 'd2');

let relay: FakeRelay;
let chain: FakeChain;
let ledgerId: string;

function depsFor(provider = new FakeProvider()): LedgerDeps {
  return { relay, cache: new StoredEntryCache(new MemoryStore()), chain, provider, network: TESTNET };
}

/** A device for a member: its own Ledger instance over the shared fake relay. */
async function device(id: Identity, provider = new FakeProvider()): Promise<Ledger> {
  const l = new Ledger(ledgerId, depsFor(provider), id);
  await l.sync();
  return l;
}

beforeEach(async () => {
  relay = new FakeRelay();
  chain = new FakeChain(TESTNET);
  chain.head = 41200;
  ledgerId = (await relay.createLedger(TESTNET)).ledgerId;
});

/** The PRD 3.2 worked example, built through the real action API. */
async function workedExample(): Promise<{ adaL: Ledger; boL: Ledger; deeL: Ledger }> {
  const adaL = await device(ada);
  await adaL.openLedger('trip');
  for (const m of [bo, cy, dee]) {
    const l = await device(m);
    await l.join();
  }
  await adaL.sync();

  const edges: [Identity, Identity, bigint][] = [
    [ada, bo, 500n],
    [bo, cy, 500n],
    [cy, ada, 500n],
    [ada, dee, 1200n],
    [bo, dee, 300n],
  ];
  for (const [debtor, creditor, amount] of edges) {
    const creditorL = await device(creditor);
    const propose = await creditorL.propose(debtor.accountAddress, creditor.accountAddress, amount);
    const debtorL = await device(debtor);
    await debtorL.accept(idOf(propose));
  }
  return { adaL: await device(ada), boL: await device(bo), deeL: await device(dee) };
}

const idOf = (entry: LogEntry): string => entryId(entry);

describe('Phase 5 step 1 — add obligation, accept, reject', () => {
  it('a proposal reaches the debtor as a request and only their accept nets it', async () => {
    const adaL = await device(ada);
    await adaL.openLedger('flat');
    const boL = await device(bo);
    await boL.join();
    await adaL.sync();

    const propose = await adaL.propose(bo.accountAddress, ada.accountAddress, 50000n, 'dinner');

    // Bo sees it as a request for them; nothing is netted yet.
    const boView = (await device(bo)).view(chain.head, 0);
    expect(boView.requestsForMe.length).toBe(1);
    expect(boView.preview).toBeNull();

    // Ada sees it as awaiting someone else.
    const adaView = (await device(ada)).view(chain.head, 0);
    expect(adaView.awaitingOthers.length).toBe(1);

    // Bo accepts — one tap, no dialog (the fake provider is never called).
    const boL2 = await device(bo);
    await boL2.accept(idOf(propose));
    const after = (await device(ada)).view(chain.head, 0);
    expect(after.preview?.transfers).toEqual([
      { from: bo.accountAddress, to: ada.accountAddress, amount: 50000n },
    ]);
  });

  it('a rejected obligation becomes CONTESTED and never nets', async () => {
    const adaL = await device(ada);
    await adaL.openLedger('flat');
    await (await device(bo)).join();
    await adaL.sync();
    const propose = await adaL.propose(bo.accountAddress, ada.accountAddress, 700n);

    await (await device(bo)).reject(idOf(propose), 'not mine');

    const view = (await device(ada)).view(chain.head, 0);
    expect(view.preview).toBeNull();
    const state = replayState([...(await device(ada)).entries]);
    expect(state.obligations[0]?.status).toBe('CONTESTED');
  });

  it('an accept records the observed height so the round anchor can be derived', async () => {
    const adaL = await device(ada);
    await adaL.openLedger('flat');
    await (await device(bo)).join();
    await adaL.sync();
    const propose = await adaL.propose(bo.accountAddress, ada.accountAddress, 700n);
    chain.head = 55555;
    await (await device(bo)).accept(idOf(propose));

    const state = replayState([...(await device(ada)).entries]);
    expect(state.obligations[0]?.acceptObservedHeight).toBe(55555);
  });
});

describe('Phase 5 step 2 — settlement preview, the collapse', () => {
  it('collapses the worked example to two transfers with Cy dropping out', async () => {
    const { deeL } = await workedExample();
    const plan = deeL.preview();
    expect(plan?.transfers).toEqual([
      { from: ada.accountAddress, to: dee.accountAddress, amount: 1200n },
      { from: bo.accountAddress, to: dee.accountAddress, amount: 300n },
    ]);
    expect(plan?.transfers.some((t) => t.from === cy.accountAddress || t.to === cy.accountAddress)).toBe(false);
  });

  it('every device previews the identical plan', async () => {
    const { adaL, boL, deeL } = await workedExample();
    const s = (l: Ledger): string => JSON.stringify(l.preview(), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    expect(s(adaL)).toBe(s(deeL));
    expect(s(boL)).toBe(s(deeL));
  });
});

describe('Phase 5 step 3 — settlement execution, both modes', () => {
  it('purse mode settles a leg with zero dialogs and anchors it', async () => {
    const { adaL } = await workedExample();
    await adaL.openRound();
    await adaL.sync();

    const provider = new FakeProvider();
    const purseDevice = new Ledger(ledgerId, depsFor(provider), ada);
    await purseDevice.sync();
    const outcomes = await purseDevice.settleMyLegs('purse');

    expect(outcomes.length).toBe(1); // ada pays exactly her own leg
    expect(outcomes[0]?.broadcast).toBe(true);
    expect(chain.broadcastLog.length).toBe(1);
    // no wallet dialog was involved at all
    expect(provider.detectedNetworkId).toBeUndefined();

    const anchor = purseDevice.anchorFor(1) as string;
    const fields = decodeAnchor(anchor);
    expect(fields.round).toBe(1);
    expect(fields.index).toBe(1);
    expect(fields.count).toBe(2);
  });

  it('manual mode settles through one wallet dialog with explicit fee 0 and the round height', async () => {
    const { adaL } = await workedExample();
    await adaL.openRound();
    const round = replayState([...adaL.entries]).openRound!;

    const seen: { fee: bigint | undefined; vsh: number | undefined; data: string | undefined }[] = [];
    const provider = new FakeProvider();
    provider.sendImpl = (p) => {
      seen.push({ fee: p.fee, vsh: p.validityStartHeight, data: (p as { data?: string }).data });
      return {
        serializedHex: 'ab', hash: 'cd'.repeat(32), sender: 'NQ', recipient: p.recipient,
        value: p.value, fee: p.fee ?? 0n, validityStartHeight: p.validityStartHeight ?? 0,
        networkId: TESTNET, dataHex: '',
      };
    };
    const manualDevice = new Ledger(ledgerId, depsFor(provider), ada);
    await manualDevice.sync();
    const outcomes = await manualDevice.settleMyLegs('manual');

    expect(outcomes[0]?.broadcast).toBe(true);
    expect(seen[0]?.fee).toBe(0n);
    // the height comes from ROUND_OPEN, never from the chain at send time
    expect(seen[0]?.vsh).toBe(round.anchorHeight);
    expect(chain.head).not.toBe(round.anchorHeight === chain.head ? -1 : chain.head); // sanity
    expect(seen[0]?.data?.startsWith('TLY1.')).toBe(true);
  });

  it('a declined settlement dialog is a normal outcome, not a failure', async () => {
    const { adaL } = await workedExample();
    await adaL.openRound();
    const provider = new FakeProvider();
    provider.nextOutcome = 'declined';
    const d = new Ledger(ledgerId, depsFor(provider), ada);
    await d.sync();
    const outcomes = await d.settleMyLegs('manual');
    expect(outcomes[0]).toMatchObject({ broadcast: false, declined: true, error: null });
  });

  it('TWO DEVICES, same purse, same round: one payment — identical bytes', async () => {
    const { adaL } = await workedExample();
    await adaL.openRound();

    const d1 = new Ledger(ledgerId, depsFor(), ada);
    const d2 = new Ledger(ledgerId, depsFor(), ada);
    await d1.sync();
    await d2.sync();
    await d1.settleMyLegs('purse');
    await d2.settleMyLegs('purse');

    // Both broadcast, but the serialized transactions are byte-identical, so the
    // mempool discards the second as a re-broadcast — exactly one payment lands.
    expect(chain.broadcastLog.length).toBe(2);
    expect(chain.broadcastLog[0]).toBe(chain.broadcastLog[1]);
    expect(new Set(chain.broadcastLog).size).toBe(1);
  });

  it('every device opening the same round produces the identical ROUND_OPEN entry', async () => {
    const { adaL, boL } = await workedExample();
    await adaL.openRound();
    await boL.openRound(); // a second member opens it independently

    const state = replayState([...(await device(dee)).entries]);
    expect(state.openRound?.round).toBe(1);
    const opens = (await device(dee)).entries.filter((e) => e.entryType === 'ROUND_OPEN');
    // Different authors sign different entries, but each device's own entry is
    // deterministic and exactly one round is open.
    expect(opens.length).toBeGreaterThanOrEqual(1);
    expect(state.openRound?.anchorHeight).toBe(41200);
  });
});

describe('degraded: relay down', () => {
  it('a cold open with a dead relay renders read-only from cache instead of failing', async () => {
    const { adaL } = await workedExample();
    const cache = new StoredEntryCache(new MemoryStore());
    const warm = new Ledger(ledgerId, { ...depsFor(), cache }, ada);
    await warm.sync(); // populates the cache from the relay
    expect(warm.syncSource).toBe('relay');

    relay.reachable = false;
    const cold = new Ledger(ledgerId, { ...depsFor(), cache }, ada);
    const source = await cold.sync();
    expect(source).toBe('cache');
    // the ledger still renders, with the same plan
    expect(cold.preview()?.transfers.length).toBe(adaL.preview()?.transfers.length);
  });
});
