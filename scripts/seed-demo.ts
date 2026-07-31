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
 * You join as ADA, the largest debtor, because Ada is the only seat where the
 * mechanic actually fires: she pays Dee 1,200 with no dialog. Joining as the
 * creditor would settle nothing on your device.
 *
 * Bo, Cy and Dee are seeded. The two obligations where ADA is the debtor are
 * left PROPOSED on purpose: accepting them is a beat in the demo, it shows the
 * consent model, and it means the collapse happens because of something you
 * just did rather than something already sitting there.
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

/**
 * The permanent public example: all four members are script identities and all
 * five PRD 3.2 obligations are accepted, so the settlement preview works the
 * instant it loads. Nobody joins it, it is read-only by convention, and it is
 * seeded separately from a recording ledger so a demo run cannot break it.
 */
async function seedExample(relayUrl: string, origin: string): Promise<void> {
  const ada = createMember('Ada');
  const bo = createMember('Bo');
  const cy = createMember('Cy');
  const dee = createMember('Dee');

  const log = new Author();
  const observedHeight = 1;
  const owe = (debtor: Member, creditor: Member, amount: bigint): void => {
    const p = log.author(creditor, 'OBLIGATION_PROPOSE', {
      debtor: debtor.address,
      creditor: creditor.address,
      amount: amount.toString(),
    });
    log.author(debtor, 'OBLIGATION_ACCEPT', { proposeId: entryId(p), observedHeight });
  };

  log.author(ada, 'LEDGER_OPEN', { name: 'Lisbon trip (live example)' });
  log.author(bo, 'MEMBER_JOIN', {});
  log.author(cy, 'MEMBER_JOIN', {});
  log.author(dee, 'MEMBER_JOIN', {});

  owe(ada, bo, 500n * NIM);
  owe(bo, cy, 500n * NIM);
  owe(cy, ada, 500n * NIM);
  owe(ada, dee, 1200n * NIM);
  owe(bo, dee, 300n * NIM);

  for (const e of log.entries) validateEntry(e);
  const state = replayState(log.entries);
  if (state.ignored.length > 0) {
    for (const i of state.ignored) console.error(`  ${i.entryType}: ${i.reason}`);
    throw new Error('the example log does not verify');
  }
  if (state.acceptedPending.length !== 5) throw new Error('expected 5 accepted obligations');

  const plan = computePlan(
    state.members.map((m) => m.address),
    state.acceptedPending.map((o): Obligation => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
    'minimal',
  );
  if (plan.transfers.length !== 2) throw new Error(`expected 2 transfers, got ${plan.transfers.length}`);

  const { ledgerId } = (await relayPost(relayUrl, '/l', { network: 5 })) as { ledgerId: string };
  await relayPost(relayUrl, `/l/${ledgerId}/entries`, { entries: log.entries.map(toRecord) });

  const nim = (l: bigint): string => (l / NIM).toLocaleString('en-US');
  const nameOf = (a: string): string =>
    [ada, bo, cy, dee].find((m) => m.address === a)?.name ?? a.slice(0, 8);
  console.log('\nSeeded the permanent live example. Five obligations, all accepted.\n');
  for (const t of plan.transfers) {
    console.log(`  ${nameOf(t.from).padEnd(4)} -> ${nameOf(t.to).padEnd(4)} ${nim(t.amount).padStart(5)} NIM`);
  }
  console.log(`\nSet this as the example ledger id in packages/app/src/config.ts:\n`);
  console.log(`  VITE_EXAMPLE_LEDGER=${ledgerId}\n`);
  console.log(`  ${origin}/l/${ledgerId}\n`);
}

async function main(): Promise<void> {
  const relayUrl = (arg('--relay') ?? 'http://localhost:8787').replace(/\/$/, '');
  const origin = (arg('--origin') ?? 'http://localhost:5174').replace(/\/$/, '');
  const expectAda = arg('--ada') ? toAddressHex(arg('--ada') as string) : null;
  const finishId = arg('--finish');

  if (process.argv.includes('--example')) {
    await seedExample(relayUrl, origin);
    return;
  }

  const seeded = finishId ? loadMembers(finishId) : [createMember('Bo'), createMember('Cy'), createMember('Dee')];
  const [bo, cy, dee] = seeded as [Member, Member, Member];

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

  /**
   * An obligation between a seeded member and Ada, who is a bare address because
   * she joins from the phone. When Ada is the CREDITOR the seeded member is the
   * debtor and can accept it. When Ada is the DEBTOR only she can accept, so it
   * stays PROPOSED for her to accept on camera.
   */
  const withAda = (member: Member, adaAddress: string, amount: bigint, adaRole: 'debtor' | 'creditor'): void => {
    const debtorAddress = adaRole === 'debtor' ? adaAddress : member.address;
    const creditorAddress = adaRole === 'debtor' ? member.address : adaAddress;
    const p = log.author(member, 'OBLIGATION_PROPOSE', {
      debtor: debtorAddress,
      creditor: creditorAddress,
      amount: amount.toString(),
    });
    if (adaRole === 'creditor') {
      log.author(member, 'OBLIGATION_ACCEPT', { proposeId: entryId(p), observedHeight });
    }
  };

  if (finishId) {
    const existing = await fetchEntries(relayUrl, finishId);
    log.resume(existing);
  } else {
  log.author(bo, 'LEDGER_OPEN', { name: 'Lisbon trip' });
  log.author(cy, 'MEMBER_JOIN', {});
  log.author(dee, 'MEMBER_JOIN', {});

  // Both parties are already members, so these can be accepted now.
  propose(cy, bo, cy.address, 500n * NIM); // Bo owes Cy 500
  propose(dee, bo, dee.address, 300n * NIM); // Bo owes Dee 300

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
  console.log(`\nSeeded "Lisbon trip" with Bo, Cy and Dee as real members.`);
  console.log('Accepted so far:\n');
  console.log('  Bo  owes Cy   500 NIM');
  console.log('  Bo  owes Dee  300 NIM\n');
  console.log('Now join as ADA, on your phone, via Discover in Nimiq Pay:\n');
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
  let ada: string | null = null;
  for (let i = 0; i < 600 && ada === null; i++) {
    await sleep(2000);
    try {
      const entries = await fetchEntries(relayUrl, ledgerId);
      const st = replayState(entries);
      const joined = st.members.map((m) => m.address).filter((a) => !known.has(a));
      const match = expectAda ? joined.find((a) => a === expectAda) : joined[0];
      if (match) {
        ada = match;
        log.resume(entries); // continue the chain after Dee's join
      }
    } catch {
      // relay hiccup, keep waiting
    }
    if (i % 15 === 14) console.log('  still waiting...');
  }
  if (ada === null) throw new Error('nobody joined within 20 minutes');

  console.log(`\nAda joined as ${ada}. Adding the rest.\n`);

  // Cy is the debtor here and Cy is seeded, so this one can be accepted.
  withAda(cy, ada, 500n * NIM, 'creditor'); // Cy owes Ada 500, accepted by Cy

  // ADA is the debtor on both of these, and only Ada can accept them. They stay
  // PROPOSED so you accept them on camera. That is the consent model, and it is
  // what makes the collapse happen live.
  withAda(bo, ada, 500n * NIM, 'debtor'); // Ada owes Bo 500, awaiting Ada
  withAda(dee, ada, 1200n * NIM, 'debtor'); // Ada owes Dee 1200, awaiting Ada

  const finalEntries = await fetchEntries(relayUrl, ledgerId);
  const merged = [...finalEntries, ...log.entries.filter((e) => !finalEntries.some((f) => entryId(f) === entryId(e)))];
  const state = replayState(merged);
  if (state.ignored.length > 0) {
    for (const i of state.ignored) console.error(`  ${i.entryType}: ${i.reason}`);
    throw new Error('the seeder produced a log that does not verify');
  }
  if (state.acceptedPending.length !== 3) {
    throw new Error(`expected 3 accepted obligations, replay found ${state.acceptedPending.length}`);
  }
  const awaitingAda = state.obligations.filter((o) => o.status === 'PROPOSED' && o.debtor === ada);
  if (awaitingAda.length !== 2) {
    throw new Error(`expected 2 obligations awaiting Ada, found ${awaitingAda.length}`);
  }

  // Check the collapse that WILL happen once Ada accepts both, so the seeder
  // fails here rather than on camera if the numbers do not work out.
  const afterAdaAccepts: Obligation[] = [
    ...state.acceptedPending.map((o) => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
    ...awaitingAda.map((o) => ({ debtor: o.debtor, creditor: o.creditor, amount: o.amount })),
  ];
  const plan = computePlan(state.members.map((m) => m.address), afterAdaAccepts, 'minimal');
  if (plan.transfers.length !== 2) {
    throw new Error(`expected the collapse to produce 2 transfers, got ${plan.transfers.length}`);
  }
  const adaPays = plan.transfers.reduce((sum, t) => (t.from === ada ? sum + t.amount : sum), 0n);
  if (adaPays !== 1200n * NIM) {
    throw new Error(`expected Ada to pay 1,200 NIM, the plan has her paying ${adaPays} Luna`);
  }

  const pending = log.entries.filter((e) => !finalEntries.some((f) => entryId(f) === entryId(e)));
  await relayPost(relayUrl, `/l/${ledgerId}/entries`, { entries: pending.map(toRecord) });

  // --- report --------------------------------------------------------------

  const nim = (luna: bigint): string => (luna / NIM).toLocaleString('en-US');
  const nameOf = (addr: string): string =>
    addr === ada ? 'You (Ada)' : (seeded.find((m) => m.address === addr)?.name ?? addr.slice(0, 8));

  console.log('Waiting for you to accept, this is the demo beat:');
  for (const o of awaitingAda) {
    console.log(`  You owe ${nameOf(o.creditor).padEnd(9)} ${nim(o.amount).padStart(5)} NIM`);
  }
  console.log('\nOnce you accept both, five obligations collapse to two transfers');
  for (const t of plan.transfers) {
    console.log(`  ${nameOf(t.from).padEnd(9)} -> ${nameOf(t.to).padEnd(9)} ${nim(t.amount).padStart(5)} NIM`);
  }
  for (const p of state.members.map((m) => m.address)) {
    if (!plan.transfers.some((t) => t.from === p || t.to === p)) {
      console.log(`  ${nameOf(p)} nets to zero and never has to open the app`);
    }
  }
  console.log(`\nReload the tab on your phone:\n\n  ${inviteUrl}\n`);
  console.log('You pay Dee 1,200 with no dialog. That is the mechanic, on camera.\n');
}

main().catch((err: unknown) => {
  console.error(`\nSeeding failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
