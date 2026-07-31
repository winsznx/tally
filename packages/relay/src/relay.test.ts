import { KeyPair, PrivateKey } from '@nimiq/core';
import {
  entryHash,
  entryId,
  entrySigningText as coreSigningText,
  signEntry,
  type LogEntry,
} from '@tally/core/log';
import { createBindingAttestation } from '@tally/core/binding';
import { describe, expect, it } from 'vitest';
import { entrySigningText, verifyEntrySignature } from './entry.js';
import { appendEntries, createLedger, getHead, getSince, getStats, newLedgerId } from './handlers.js';
import { InMemoryStore } from './store.js';

function hex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

const account = KeyPair.derive(PrivateKey.fromHex('a1'.repeat(32)));
const purse = KeyPair.derive(PrivateKey.fromHex('a2'.repeat(32)));
const addr = hex(account.toAddress().serialize());
const pursePk = hex(purse.publicKey.serialize());

let nonce = 0;
function realEntry(): { record: Record<string, unknown>; entry: LogEntry } {
  nonce += 1;
  const att = createBindingAttestation(account, pursePk);
  const entry = signEntry(
    {
      prevEntryHash: null,
      entryType: 'LEDGER_OPEN',
      payload: { name: 'trip', accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature },
      authorAddress: addr,
      pursePublicKey: pursePk,
      nonce: nonce.toString(16).padStart(32, '0'),
      logicalClock: 0,
    },
    purse,
  );
  return { record: { ...entry, entryId: entryId(entry), entryHash: entryHash(entry) }, entry };
}

describe('relay signing text matches @tally/core exactly (no drift)', () => {
  it('produces byte-identical signing text for a real entry', () => {
    const { entry } = realEntry();
    // Both functions read the same fields and ignore purseSignature.
    expect(entrySigningText(entry)).toBe(coreSigningText(entry));
  });

  it('verifies a genuine core-signed entry and rejects a tampered one (Web Crypto Ed25519)', async () => {
    const { entry } = realEntry();
    expect(await verifyEntrySignature(entry)).toBe(true);
    expect(await verifyEntrySignature({ ...entry, payload: { ...entry.payload, name: 'evil' } })).toBe(false);
    expect(await verifyEntrySignature({ ...entry, purseSignature: '00'.repeat(64) })).toBe(false);
  });
});

describe('ledger ids (GAP 7)', () => {
  it('are 26-char base32 and unguessable', () => {
    const id = newLedgerId((n) => new Uint8Array(n).fill(255));
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    const a = newLedgerId((n) => crypto.getRandomValues(new Uint8Array(n)));
    const b = newLedgerId((n) => crypto.getRandomValues(new Uint8Array(n)));
    expect(a).not.toBe(b);
  });
});

describe('relay handlers', () => {
  it('creates a network-scoped ledger and rejects a bad network', async () => {
    const store = new InMemoryStore();
    const ok = await createLedger(store, 5, 0, (n) => new Uint8Array(n).fill(1));
    expect(ok.status).toBe(200);
    const bad = await createLedger(store, 99, 0, (n) => new Uint8Array(n).fill(1));
    expect(bad.status).toBe(400);
  });

  it('appends verified entries, dedups on entryId, tracks head, and rejects garbage', async () => {
    const store = new InMemoryStore();
    const { ledgerId } = (await createLedger(store, 5, 0, (n) => crypto.getRandomValues(new Uint8Array(n)))).body as {
      ledgerId: string;
    };
    const { record } = realEntry();

    const res1 = await appendEntries(store, ledgerId, [record, record], 1); // duplicate collapses
    expect(res1.body).toEqual({ accepted: 1, rejected: 0 });

    const garbage = { ...record, purseSignature: '00'.repeat(64) };
    const res2 = await appendEntries(store, ledgerId, [garbage], 2);
    expect(res2.body).toEqual({ accepted: 0, rejected: 1 });

    const head = (await getHead(store, ledgerId)).body as { head: string };
    expect(head.head).toBe((record as { entryHash: string }).entryHash);

    const since = (await getSince(store, ledgerId, null)).body as { entries: unknown[] };
    expect(since.entries.length).toBe(1);
  });

  it('returns entries since a cursor and 404s an unknown ledger', async () => {
    const store = new InMemoryStore();
    const { ledgerId } = (await createLedger(store, 5, 0, (n) => crypto.getRandomValues(new Uint8Array(n)))).body as {
      ledgerId: string;
    };
    const first = realEntry();
    const second = realEntry();
    await appendEntries(store, ledgerId, [first.record, second.record], 1);
    const cursor = (first.record as { entryHash: string }).entryHash;
    const since = (await getSince(store, ledgerId, cursor)).body as { entries: { entryId: string }[] };
    expect(since.entries.length).toBe(1);
    expect(since.entries[0]!.entryId).toBe((second.record as { entryId: string }).entryId);
    expect((await getHead(store, 'nope')).status).toBe(404);
  });

  it('counts distinct account addresses for /stats (GAP 6)', async () => {
    const store = new InMemoryStore();
    const { ledgerId } = (await createLedger(store, 5, 0, (n) => crypto.getRandomValues(new Uint8Array(n)))).body as {
      ledgerId: string;
    };
    await appendEntries(store, ledgerId, [realEntry().record], 1);
    await appendEntries(store, ledgerId, [realEntry().record], 2);
    // both entries authored by the same account → one distinct account
    expect((await getStats(store)).body).toEqual({ uniqueAccounts: 1 });
  });

  it('enforces the per-ip rate limit', async () => {
    const store = new InMemoryStore();
    let allowed = 0;
    for (let i = 0; i < 5; i++) if (await store.hitRateLimit('iphash', 0, 3)) allowed += 1;
    expect(allowed).toBe(3);
  });
});
