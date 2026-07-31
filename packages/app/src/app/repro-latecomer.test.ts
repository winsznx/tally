import { KeyPair, PrivateKey } from '@nimiq/core';
import { entryId, replayState, type LogEntry } from '@tally/core/log';
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
const late = identity('e1', 'e2');

let relay: FakeRelay;
let chain: FakeChain;
let ledgerId: string;

function depsFor(provider = new FakeProvider()): LedgerDeps {
  return { relay, cache: new StoredEntryCache(new MemoryStore()), chain, provider, network: TESTNET };
}

async function device(id: Identity): Promise<Ledger> {
  const l = new Ledger(ledgerId, depsFor(), id);
  await l.sync();
  return l;
}

const idOf = (entry: LogEntry): string => entryId(entry);

beforeEach(async () => {
  relay = new FakeRelay();
  chain = new FakeChain(TESTNET);
  chain.head = 41200;
  ledgerId = (await relay.createLedger(TESTNET)).ledgerId;
});

describe('REPRO: latecomer joins mid-round', () => {
  it('a zero-position latecomer changes the round root, so the same leg pays twice', async () => {
    const adaL = await device(ada);
    await adaL.openLedger('trip');
    await (await device(bo)).join();
    await adaL.sync();

    // Bo (the creditor) proposes; Ada (the debtor) accepts.
    const boL = await device(bo);
    const propose = await boL.propose(ada.accountAddress, bo.accountAddress, 100_000n, 'taxi');
    const adaAccept = await device(ada);
    await adaAccept.accept(idOf(propose));

    // Ada opens round 1 and settles her leg from her purse.
    const adaSettle = await device(ada);
    await adaSettle.openRound();
    await adaSettle.sync();
    const rootBefore = hex(adaSettle.roundRoot() as Uint8Array);
    const anchorBefore = adaSettle.anchorFor(1) as string;
    const out1 = await adaSettle.settleMyLegs('purse');
    expect(out1).toEqual([
      { legIndex: 1, broadcast: true, declined: false, txHash: expect.any(String), error: null },
    ]);
    expect(chain.broadcastLog.length).toBe(1);

    // A friend scans the invite QR and joins. No obligations, no position.
    const lateL = await device(late);
    await lateL.join();

    const stateAfter = replayState([...(await device(ada)).entries]);
    expect(stateAfter.members.length).toBe(3);
    expect(stateAfter.openRound?.round).toBe(1); // the SAME round is still open

    // Ada's device re-syncs and settles the SAME round again (retry / 2nd device).
    const adaAgain = new Ledger(ledgerId, depsFor(), ada);
    await adaAgain.sync();
    const rootAfter = hex(adaAgain.roundRoot() as Uint8Array);
    const anchorAfter = adaAgain.anchorFor(1) as string;
    const out2 = await adaAgain.settleMyLegs('purse');

    // The plan's transfers are byte-identical...
    const planBefore = adaSettle.preview;
    expect(out2[0]?.broadcast).toBe(true);
    // ...but the root, the anchor and therefore the transaction are NOT.
    // eslint-disable-next-line no-console
    console.log({ rootBefore, rootAfter, anchorBefore, anchorAfter, planBefore: typeof planBefore });
    expect(rootAfter).not.toBe(rootBefore);
    expect(anchorAfter).not.toBe(anchorBefore);

    // Two DIFFERENT signed transactions for the same 100_000 Luna debt.
    expect(chain.broadcastLog.length).toBe(2);
    expect(chain.broadcastLog[0]).not.toBe(chain.broadcastLog[1]);
    expect(new Set(chain.broadcastLog).size).toBe(2);
    expect(out1[0]?.txHash).not.toBe(out2[0]?.txHash);
  });

  it('CONTROL: with no latecomer, the two settles are byte-identical (existing property)', async () => {
    const adaL = await device(ada);
    await adaL.openLedger('trip');
    await (await device(bo)).join();
    await adaL.sync();
    const boL = await device(bo);
    const propose = await boL.propose(ada.accountAddress, bo.accountAddress, 100_000n);
    await (await device(ada)).accept(idOf(propose));
    const d1 = await device(ada);
    await d1.openRound();
    await d1.sync();
    await d1.settleMyLegs('purse');
    const d2 = new Ledger(ledgerId, depsFor(), ada);
    await d2.sync();
    await d2.settleMyLegs('purse');
    expect(chain.broadcastLog.length).toBe(2);
    expect(new Set(chain.broadcastLog).size).toBe(1);
  });
});
