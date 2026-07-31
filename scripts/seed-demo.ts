/**
 * Seed a demo ledger with real cryptographic members.
 *
 * Recording the demo needs three other people. This creates them: Ada, Bo and Cy
 * as genuine identities, with generated account keys, real binding attestations
 * signed by those account keys, and real purse-signed log entries. Nothing here
 * is a fixture or a stub. The seeded log goes through `replayState` exactly like
 * a log built on a phone, and the script fails if a single entry is rejected.
 *
 * The obligations are PRD 3.2 verbatim:
 *
 *   Ada -> Bo   500      Ada -> Dee  1200
 *   Bo  -> Cy   500      Bo  -> Dee   300
 *   Cy  -> Ada  500
 *
 * You join as Dee from your phone. The three-way cycle between Ada, Bo and Cy
 * cancels exactly, so the tab collapses to two transfers into your account and
 * Cy drops out of the round without opening anything.
 *
 * Usage:
 *   pnpm seed:demo --dee <your Nimiq Pay address> [--relay <url>] [--origin <url>]
 *
 * Amounts are Luna (1 NIM = 100,000 Luna). Testnet only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Address, KeyPair, PrivateKey } from '@nimiq/core';
import { createBindingAttestation } from '@tally/core/binding';
import {
  entryHash,
  entryId,
  replayState,
  signEntry,
  validateEntry,
  type EntryType,
  type LogEntry,
} from '@tally/core/log';
import { computePlan, type Obligation } from '@tally/core/netting';

const NIM = 100_000n;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Accepts a user-friendly NQ address or 40 hex, returns 40 hex. */
function toAddressHex(input: string): string {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  try {
    return bytesToHex(Address.fromString(trimmed).serialize());
  } catch {
    throw new Error(`not a valid Nimiq address: "${input}"`);
  }
}

interface Member {
  name: string;
  account: KeyPair;
  purse: KeyPair;
  address: string;
  pursePublicKey: string;
}

function createMember(name: string): Member {
  const account = KeyPair.generate();
  const purse = KeyPair.generate();
  return {
    name,
    account,
    purse,
    address: bytesToHex(account.toAddress().serialize()),
    pursePublicKey: bytesToHex(purse.publicKey.serialize()),
  };
}

/** Authors a signed entry exactly as the app does, including the attestation. */
class Author {
  #head: string | null = null;
  #clock = 0;
  readonly entries: LogEntry[] = [];

  /** Continue the chain after entries authored elsewhere (e.g. Dee's join). */
  resume(all: readonly LogEntry[]): void {
    if (all.length === 0) return;
    this.#head = entryHash(all[all.length - 1] as LogEntry);
    this.#clock = all.reduce((max, e) => Math.max(max, e.logicalClock), 0);
  }

  author(member: Member, entryType: EntryType, payload: Record<string, unknown>): LogEntry {
    const isOpen = entryType === 'LEDGER_OPEN';
    let full = payload;
    if (isOpen || entryType === 'MEMBER_JOIN') {
      // A real attestation: the ACCOUNT key signs a message naming its purse.
      const att = createBindingAttestation(member.account, member.pursePublicKey);
      full = { ...payload, accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature };
    }
    const entry = signEntry(
      {
        prevEntryHash: isOpen ? null : this.#head,
        entryType,
        payload: full,
        authorAddress: member.address,
        pursePublicKey: member.pursePublicKey,
        nonce: randomNonce(),
        logicalClock: isOpen ? 0 : ++this.#clock,
      },
      member.purse,
    );
    this.#head = entryHash(entry);
    this.#clock = entry.logicalClock;
    this.entries.push(entry);
    return entry;
  }
}

/**
 * Throwaway testnet identities are saved so a later `--finish` can keep
 * authoring as Ada and Bo. The directory is gitignored. These keys hold nothing
 * and exist only to make a demo recordable without three phones.
 */
const SEED_DIR = '.demo-seed';

function saveMembers(ledgerId: string, members: Member[]): void {
  mkdirSync(SEED_DIR, { recursive: true });
  writeFileSync(
    `${SEED_DIR}/${ledgerId}.json`,
    JSON.stringify(
      members.map((m) => ({ name: m.name, account: m.account.privateKey.toHex(), purse: m.purse.privateKey.toHex() })),
      null,
      2,
    ),
  );
}

function loadMembers(ledgerId: string): Member[] {
  const raw = JSON.parse(readFileSync(`${SEED_DIR}/${ledgerId}.json`, 'utf8')) as {
    name: string;
    account: string;
    purse: string;
  }[];
  return raw.map(({ name, account, purse }) => {
    const accountKp = KeyPair.derive(PrivateKey.fromHex(account));
    const purseKp = KeyPair.derive(PrivateKey.fromHex(purse));
    return {
      name,
      account: accountKp,
      purse: purseKp,
      address: bytesToHex(accountKp.toAddress().serialize()),
      pursePublicKey: bytesToHex(purseKp.publicKey.serialize()),
    };
  });
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function relayGet(relayUrl: string, path: string): Promise<unknown> {
  const res = await fetch(`${relayUrl}${path}`);
  if (!res.ok) throw new Error(`relay GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function relayPost(relayUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${relayUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`relay POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

function toRecord(e: LogEntry): Record<string, unknown> {
  return { ...e, entryId: entryId(e), entryHash: entryHash(e) };
}

/** Every entry the relay holds, re-verified locally like any client would. */
async function fetchEntries(relayUrl: string, ledgerId: string): Promise<LogEntry[]> {
  const rows = (await relayGet(relayUrl, `/l/${ledgerId}/since/genesis`)) as { entries?: { entryJson: string }[] };
  const out: LogEntry[] = [];
  for (const row of rows.entries ?? []) {
    const entry = JSON.parse(row.entryJson) as LogEntry;
    validateEntry(entry);
    out.push(entry);
  }
  return out;
}

async function main(): Promise<void> {
  const relayUrl = (arg('--relay') ?? 'http://localhost:8787').replace(/\/$/, '');
  const origin = (arg('--origin') ?? 'http://localhost:5174').replace(/\/$/, '');
  const expectDee = arg('--dee') ? toAddressHex(arg('--dee') as string) : null;
  const finishId = arg('--finish');

  const seeded = finishId ? loadMembers(finishId) : [createMember('Ada'), createMember('Bo'), createMember('Cy')];
  const [ada, bo, cy] = seeded as [Member, Member, Member];

  // --- stage 1: the three-way cycle, which needs nobody else --------------

  const log = new Author();
  const observedHeight = 1;
  const propose = (creditorSigner: Member, debtor: Member, creditorAddress: string, amount: bigint): void => {
    const p = log.author(creditorSigner, 'OBLIGATION_PROPOSE', {
      debtor: debtor.address,
      creditor: creditorAddress,
      amount: amount.toString(),
    });
    // Silence is never consent: only the named debtor's own signed acceptance
    // moves an obligation into netting.
    log.author(debtor, 'OBLIGATION_ACCEPT', { proposeId: entryId(p), observedHeight });
  };

  if (finishId) {
    const existing = await fetchEntries(relayUrl, finishId);
    log.resume(existing);
  } else {
  log.author(ada, 'LEDGER_OPEN', { name: 'Lisbon trip' });
  log.author(bo, 'MEMBER_JOIN', {});
  log.author(cy, 'MEMBER_JOIN', {});

  propose(bo, ada, bo.address, 500n * NIM); // Ada owes Bo 500
  propose(cy, bo, cy.address, 500n * NIM); // Bo owes Cy 500
  propose(ada, cy, ada.address, 500n * NIM); // Cy owes Ada 500

  for (const entry of log.entries) validateEntry(entry);
  const stage1 = replayState(log.entries);
  if (stage1.ignored.length > 0) {
    for (const i of stage1.ignored) console.error(`  ${i.entryType}: ${i.reason}`);
    throw new Error('the seeder produced a log that does not verify');
  }
  }

  const ledgerId =
    finishId ?? ((await relayPost(relayUrl, '/l', { network: 5 })) as { ledgerId: string }).ledgerId;
  if (!finishId) {
    saveMembers(ledgerId, seeded);
    await relayPost(relayUrl, `/l/${ledgerId}/entries`, { entries: log.entries.map(toRecord) });
  }

  const inviteUrl = `${origin}/l/${ledgerId}`;
  if (!finishId) {
  console.log(`\nSeeded "Lisbon trip" with Ada, Bo and Cy as real members.`);
  console.log(`Their three debts cancel exactly, so right now the tab settles to nothing.\n`);
  console.log('  Ada owes Bo   500 NIM');
  console.log('  Bo  owes Cy   500 NIM');
  console.log('  Cy  owes Ada  500 NIM\n');
  console.log('Now join as Dee, on your phone, via Discover in Nimiq Pay:\n');
  console.log(`  ${inviteUrl}\n`);
  console.log('Waiting for you to join. Ctrl-C to stop and add the rest later with');
  console.log(`  pnpm seed:demo --finish ${ledgerId}\n`);
  } else {
    console.log(`\nResuming ${ledgerId}. Waiting for Dee to join.\n`);
  }

  // --- stage 2: wait for Dee, then add the debts owed TO Dee --------------
  //
  // Replay requires both parties of an obligation to be members, so the debts
  // naming Dee cannot exist until Dee has joined. That rule is not bypassed
  // here; the seeder waits for it instead.

  const known = new Set(seeded.map((m) => m.address));
  let dee: string | null = null;
  for (let i = 0; i < 600 && dee === null; i++) {
    await sleep(2000);
    try {
      const entries = await fetchEntries(relayUrl, ledgerId);
      const st = replayState(entries);
      const joined = st.members.map((m) => m.address).filter((a) => !known.has(a));
      const match = expectDee ? joined.find((a) => a === expectDee) : joined[0];
      if (match) {
        dee = match;
        log.resume(entries); // continue the chain after Dee's join
      }
    } catch {
      // relay hiccup, keep waiting
    }
    if (i % 15 === 14) console.log('  still waiting...');
  }
  if (dee === null) throw new Error('nobody joined within 20 minutes');

  console.log(`\nDee joined as ${dee}. Adding the two debts owed to you.\n`);
  propose(ada, ada, dee, 1200n * NIM); // Ada owes Dee 1200
  propose(bo, bo, dee, 300n * NIM); // Bo owes Dee 300

  const finalEntries = await fetchEntries(relayUrl, ledgerId);
  const merged = [...finalEntries, ...log.entries.filter((e) => !finalEntries.some((f) => entryId(f) === entryId(e)))];
  const state = replayState(merged);
  if (state.ignored.length > 0) {
    for (const i of state.ignored) console.error(`  ${i.entryType}: ${i.reason}`);
    throw new Error('the seeder produced a log that does not verify');
  }
  if (state.acceptedPending.length !== 5) {
    throw new Error(`expected 5 accepted obligations, replay found ${state.acceptedPending.length}`);
  }

  const plan = computePlan(
    state.members.map((m) => m.address),
    state.acceptedPending.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
    'minimal',
  );
  if (plan.transfers.length !== 2) {
    throw new Error(`expected the collapse to produce 2 transfers, got ${plan.transfers.length}`);
  }
  const deeReceives = plan.transfers.reduce((sum, t) => (t.to === dee ? sum + t.amount : sum), 0n);
  if (deeReceives !== 1500n * NIM) {
    throw new Error(`expected Dee to receive 1,500 NIM, the plan gives ${deeReceives} Luna`);
  }

  const pending = log.entries.filter((e) => !finalEntries.some((f) => entryId(f) === entryId(e)));
  await relayPost(relayUrl, `/l/${ledgerId}/entries`, { entries: pending.map(toRecord) });

  // --- report --------------------------------------------------------------

  const nim = (luna: bigint): string => (luna / NIM).toLocaleString('en-US');
  const nameOf = (addr: string): string =>
    addr === dee ? 'You (Dee)' : (seeded.find((m) => m.address === addr)?.name ?? addr.slice(0, 8));

  console.log('Five obligations, all accepted, collapse to two transfers');
  for (const t of plan.transfers) {
    console.log(`  ${nameOf(t.from).padEnd(9)} -> ${nameOf(t.to).padEnd(9)} ${nim(t.amount).padStart(5)} NIM`);
  }
  for (const p of state.members.map((m) => m.address)) {
    if (!plan.transfers.some((t) => t.from === p || t.to === p)) {
      console.log(`  ${nameOf(p)} nets to zero and never has to open the app`);
    }
  }
  console.log(`\nReload the tab on your phone:\n\n  ${inviteUrl}\n`);
}

main().catch((err: unknown) => {
  console.error(`\nSeeding failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
