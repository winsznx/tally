import { randomBytes } from 'node:crypto';
import { KeyPair, PrivateKey } from '@nimiq/core';
import { createBindingAttestation } from '@tally/core/binding';
import { TallyLog, signEntry, type EntryType, type LogEntry } from '@tally/core/log';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { runMigrations } from '../src/migrations.js';
import { Reconciler } from '../src/reconciler.js';
import { NimiqRpc } from '../src/rpc.js';

export const ADMIN_URL = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgresql://localhost:5432/postgres';

export interface TestDatabase {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `tally_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), () => undefined);
  if (options.migrate !== false) await runMigrations(pool);
  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

// --- members and signed entries, mirroring core's settle tests ---------------

export interface Member {
  account: KeyPair;
  session: KeyPair;
}

export const mk = (a: string, b: string): Member => ({
  account: KeyPair.derive(PrivateKey.fromHex(a.repeat(32))),
  session: KeyPair.derive(PrivateKey.fromHex(b.repeat(32))),
});

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export const addr = (m: Member): string => hex(m.account.toAddress().serialize());
export const sessionPk = (m: Member): string => hex(m.session.publicKey.serialize());

let nonceCounter = 0;
export const nextNonce = (): string => randomBytes(12).toString('hex') + (++nonceCounter).toString(16).padStart(8, '0');

export function registration(m: Member, payload: Record<string, unknown>): Record<string, unknown> {
  const att = createBindingAttestation(m.account, sessionPk(m), 2);
  return { ...payload, accountPublicKey: att.accountPublicKey, bindingSignature: att.bindingSignature };
}

export function signAs(
  m: Member,
  entryType: EntryType,
  payload: Record<string, unknown>,
  at: { prevEntryHash: string | null; logicalClock: number; nonce?: string },
): LogEntry {
  const full = entryType === 'LEDGER_OPEN' || entryType === 'MEMBER_JOIN' ? registration(m, payload) : payload;
  return signEntry(
    {
      prevEntryHash: at.prevEntryHash,
      entryType,
      payload: full,
      authorAddress: addr(m),
      pursePublicKey: sessionPk(m),
      nonce: at.nonce ?? nextNonce(),
      logicalClock: at.logicalClock,
    },
    m.session,
  );
}

/** A local, linear copy of a tab's log that hands out correctly chained entries. */
export class LogBuilder {
  readonly log = new TallyLog();

  add(m: Member, entryType: EntryType, payload: Record<string, unknown>): LogEntry {
    const e = signAs(m, entryType, payload, {
      prevEntryHash: this.log.headHash,
      logicalClock: entryType === 'LEDGER_OPEN' ? 0 : this.log.length,
    });
    this.log.append(e);
    return e;
  }

  static tab(...members: Member[]): LogBuilder {
    const b = new LogBuilder();
    b.add(members[0] as Member, 'LEDGER_OPEN', { name: 'Weekend', displayName: 'Ada' });
    for (const m of members.slice(1)) b.add(m, 'MEMBER_JOIN', { displayName: 'Friend' });
    return b;
  }
}

// --- fake chain ---------------------------------------------------------------

export interface FakeTx {
  hash: string;
  from: string;
  to: string;
  value: number;
  recipientData: string;
  networkId: number;
  blockNumber?: number;
  executionResult?: boolean;
}

/** Serves Albatross JSON-RPC responses for NimiqRpc through an injected fetch. */
export class FakeChain {
  head = 1000;
  down = false;
  calls: string[] = [];
  readonly txs = new Map<string, FakeTx>();

  readonly fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    this.calls.push(body.method);
    if (this.down) return new Response('upstream down', { status: 503 });
    const reply = (payload: object): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (body.method === 'getBlockNumber') return reply({ result: { data: this.head, metadata: null } });
    if (body.method === 'getTransactionByHash') {
      const hash = String(body.params[0]);
      const tx = this.txs.get(hash);
      if (!tx) return reply({ error: { code: -32603, message: 'Internal error', data: `Transaction not found: ${hash}` } });
      return reply({
        result: {
          data: { fromType: 0, toType: 0, fee: 0, senderData: '', flags: 0, confirmations: 1, ...tx },
          metadata: null,
        },
      });
    }
    return reply({ error: { code: -32601, message: 'Method not found' } });
  };

  rpc(): NimiqRpc {
    return new NimiqRpc({ url: 'http://fake-rpc.test', fetch: this.fetch, minIntervalMs: 0, maxRetries: 1, retryBaseMs: 1 });
  }
}

// --- app ----------------------------------------------------------------------

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgresql://unused',
    port: 0,
    host: '127.0.0.1',
    corsOrigins: ['https://app.tally.test'],
    nimiqRpcUrl: 'http://fake-rpc.test',
    networkId: 24,
    trustProxy: false,
    reconcileIntervalMs: 15_000,
    appVersion: 'test',
    ...overrides,
  };
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface TestApp {
  app: FastifyInstance;
  chain: FakeChain;
  reconciler: Reconciler;
}

export async function createTestApp(pool: Pool, overrides: Partial<Config> = {}): Promise<TestApp> {
  const chain = new FakeChain();
  const rpc = chain.rpc();
  const config = testConfig(overrides);
  const reconciler = new Reconciler({ pool, chain: rpc, log: silentLog, intervalMs: config.reconcileIntervalMs });
  const app = await buildApp({ config, pool, chain: rpc, reconciler });
  await app.ready();
  return { app, chain, reconciler };
}

export async function createTab(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/tabs', payload: { network: 24 } });
  return (res.json() as { tabId: string }).tabId;
}

export async function append(app: FastifyInstance, tabId: string, entries: unknown[]) {
  return app.inject({ method: 'POST', url: `/api/v1/tabs/${tabId}/entries`, payload: { entries } });
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const utf8Hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
