import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import {
  LogBuilder,
  addr,
  append,
  createTab,
  createTestApp,
  createTestDatabase,
  mk,
  type TestApp,
  type TestDatabase,
} from './helpers.js';

const ada = mk('a1', 'a2');
const bo = mk('b1', 'b2');

let db: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.pool);
});

afterAll(async () => {
  await t.app.close();
  await db.drop();
});

const errorCode = (res: { json(): unknown }): string => (res.json() as { error: { code: string } }).error.code;

describe('health and readiness', () => {
  it('reports ok with the version and nothing else', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: 'test' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed incoming request id and replaces a malformed one', async () => {
    const kept = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'edge-123' } });
    expect(kept.headers['x-request-id']).toBe('edge-123');
    const replaced = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\nx' } });
    expect(replaced.headers['x-request-id']).not.toContain('bad');
  });

  it('returns 503 when the database is unreachable', async () => {
    const pool = createPool('postgresql://127.0.0.1:1/nowhere', () => undefined);
    const broken = await createTestApp(pool);
    try {
      const res = await broken.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: { code: 'db_unavailable', message: 'database unreachable' } });
      expect(res.headers['x-request-id']).toBeDefined();
    } finally {
      await broken.app.close();
      await pool.end();
    }
  });

  it('is ready only when both the database and the chain answer', async () => {
    t.chain.head = 1234;
    const ready = await t.app.inject({ method: 'GET', url: '/ready' });
    expect([ready.statusCode, ready.json()]).toEqual([200, { db: 'ok', chain: 'ok', head: 1234 }]);
    t.chain.down = true;
    const notReady = await t.app.inject({ method: 'GET', url: '/ready' });
    t.chain.down = false;
    expect([notReady.statusCode, notReady.json()]).toEqual([503, { db: 'ok', chain: 'error', head: null }]);
  });
});

describe('errors', () => {
  it('uses the error shape for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'no such route' } });
  });

  it('caps the body at 256 KB', async () => {
    const tabId = await createTab(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/tabs/${tabId}/entries`,
      payload: { entries: ['x'.repeat(300 * 1024)] },
    });
    expect(res.statusCode).toBe(413);
    expect(errorCode(res)).toBe('payload_too_large');
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/tabs',
      headers: { origin: 'https://app.tally.test', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.tally.test');
  });

  it('rejects an unlisted origin, preflight or not', async () => {
    for (const method of ['OPTIONS', 'GET'] as const) {
      const res = await t.app.inject({
        method,
        url: '/health',
        headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(errorCode(res)).toBe('origin_not_allowed');
    }
  });

  it('serves requests without an Origin header', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});

describe('metrics and stats', () => {
  const event = { event: 'app_opened', installId: 'install_abcdefghij12', appVersion: '1.2.3' };

  it('accepts allowlisted events and nothing that could carry an address', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/metrics/consented-event', payload: event });
    expect(ok.statusCode).toBe(202);
    for (const payload of [
      { ...event, event: 'wallet_balance' },
      { ...event, installId: 'short' },
      { ...event, address: addr(ada) },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/metrics/consented-event', payload });
      expect(res.statusCode).toBe(422);
    }
  });

  it('rate-limits the metrics endpoint hard', async () => {
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/metrics/consented-event', payload: event });
      if (res.statusCode === 429) {
        limited += 1;
        expect(errorCode(res)).toBe('rate_limited');
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('reports aggregates only', async () => {
    const tabId = await createTab(t.app);
    const b = LogBuilder.tab(ada, bo);
    const shares = [
      { member: addr(ada), amount: '10' },
      { member: addr(bo), amount: '10' },
    ].sort((x, y) => (x.member < y.member ? -1 : 1));
    const expense = b.add(ada, 'EXPENSE_RECORD', { title: 'Taxi', total: '20', method: 'equal', shares });
    await append(t.app, tabId, [...b.log.all()]);
    const { replayState } = await import('@tally/core/log');
    const proposeId = replayState([...b.log.all()]).obligations[0]?.proposeId as string;
    b.add(bo, 'OBLIGATION_ACCEPT', { proposeId, observedHeight: 100 });
    await append(t.app, tabId, [...b.log.all()]);
    expect(expense.entryType).toBe('EXPENSE_RECORD');

    const res = await t.app.inject({ method: 'GET', url: '/api/v1/stats' });
    const stats = res.json() as Record<string, unknown>;
    expect(stats).toMatchObject({
      tabsWithTwoPlusMembers: 1,
      distinctMembers: 2,
      expenses: 1,
      acceptedShares: 1,
      paymentsConfirmed: 0,
      events: { app_opened: expect.any(Number) },
    });
    expect(JSON.stringify(stats)).not.toContain(addr(ada));
  });
});

describe('config', () => {
  it('applies defaults and treats empty values as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://x/y', CORS_ORIGINS: '', NIMIQ_NETWORK_ID: '' });
    expect(c).toMatchObject({ port: 8080, host: '0.0.0.0', networkId: 24, corsOrigins: [], trustProxy: false });
    expect(loadConfig({ DATABASE_URL: 'x', NIMIQ_NETWORK_ID: '5', TRUST_PROXY: 'true' })).toMatchObject({
      networkId: 5,
      trustProxy: true,
    });
  });

  it('fails fast on a wildcard origin, a bad network or a missing database', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', CORS_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'x', CORS_ORIGINS: 'https://a.test/path' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'x', NIMIQ_NETWORK_ID: '42' })).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
