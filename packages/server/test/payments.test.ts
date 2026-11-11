import { paymentMemo, paymentRef, replayState } from '@tally/core/log';
import { toUserFriendly } from '@tally/core/settle';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LogBuilder,
  addr,
  append,
  createTab,
  createTestApp,
  createTestDatabase,
  mk,
  utf8Hex,
  waitFor,
  type TestApp,
  type TestDatabase,
} from './helpers.js';

const ada = mk('a1', 'a2');
const bo = mk('b1', 'b2');
const cy = mk('c1', 'c2');

let db: TestDatabase;
let t: TestApp;
let tabId: string;
let genesisHash: string;
let builder: LogBuilder;

interface Intent {
  id: string;
  tabId: string;
  payer: string;
  recipient: string;
  amount: string;
  ref: string;
  memo: string;
  network: number;
  txHash: string | null;
  state: string;
  checkCount: number;
  blockNumber: number | null;
  verification: { status: string | null; reason: string | null; checkedAt: string | null };
  observations?: { status: string; payloadDigest: string | null }[];
}

const errorCode = (res: { json(): unknown }): string => (res.json() as { error: { code: string } }).error.code;

let refCounter = 0;
const freshRef = (): string => {
  refCounter += 1;
  return `aaaaaaaaaaaa${'abcdefghijklmnopqrstuvwxyz234567'[refCounter % 32]}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(refCounter / 32) % 32]}aa`;
};
let hashCounter = 0;
const freshHash = (): string => (++hashCounter).toString(16).padStart(64, '0');

function intentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId,
    payer: addr(bo),
    recipient: addr(ada),
    amount: '154097',
    ref: freshRef(),
    network: 24,
    idempotencyKey: `key-${refCounter}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

async function createIntent(overrides: Record<string, unknown> = {}): Promise<Intent> {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/payment-intents', payload: intentBody(overrides) });
  expect(res.statusCode).toBe(201);
  return res.json() as Intent;
}

async function submit(id: string, txHash: string) {
  return t.app.inject({ method: 'POST', url: `/api/v1/payment-intents/${id}/submission`, payload: { txHash } });
}

async function getIntent(id: string): Promise<Intent> {
  return (await t.app.inject({ method: 'GET', url: `/api/v1/payment-intents/${id}` })).json() as Intent;
}

/** Puts a transaction on the fake chain that exactly proves the intent. */
function chainTx(intent: Intent, hash: string, over: Partial<{ value: number; blockNumber: number; executionResult: boolean }> = {}) {
  t.chain.txs.set(hash, {
    hash,
    from: toUserFriendly(intent.payer),
    to: toUserFriendly(intent.recipient),
    value: Number(intent.amount),
    recipientData: utf8Hex(intent.memo),
    networkId: 24,
    blockNumber: over.blockNumber ?? 600,
    executionResult: over.executionResult ?? true,
  });
  if (over.value !== undefined) {
    const tx = t.chain.txs.get(hash);
    if (tx) tx.value = over.value;
  }
}

/** Polls the database directly so waiting does not spend the per-IP rate limit. */
async function settled(id: string, done: (row: { state: string; check_count: number }) => boolean): Promise<void> {
  await waitFor(async () => {
    const { rows } = await db.pool.query<{ state: string; check_count: number }>(
      'SELECT state, check_count FROM payment_intents WHERE id = $1',
      [id],
    );
    return rows[0] !== undefined && done(rows[0]);
  });
}

async function verify(hash: string) {
  return t.app.inject({ method: 'GET', url: `/api/v1/transactions/${hash}/verification?tabId=${tabId}` });
}

beforeAll(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.pool);
  tabId = await createTab(t.app);
  builder = LogBuilder.tab(ada, bo);
  await append(t.app, tabId, [...builder.log.all()]);
  genesisHash = replayState([...builder.log.all()]).genesisHash as string;
});

afterAll(async () => {
  await t.app.close();
  await db.drop();
});

beforeEach(() => {
  t.chain.down = false;
  t.chain.head = 1000;
  t.chain.txs.clear();
});

describe('payment intents', () => {
  it('creates an intent with the memo derived from the genesis hash', async () => {
    const intent = await createIntent();
    expect(intent.state).toBe('created');
    expect(intent.memo).toBe(paymentMemo(genesisHash, intent.ref));
    expect(intent.amount).toBe('154097');
    expect(intent.verification).toEqual({ status: null, reason: null, checkedAt: null });
  });

  it('is idempotent on ref and rejects a differing replay', async () => {
    const body = intentBody();
    const first = await t.app.inject({ method: 'POST', url: '/api/v1/payment-intents', payload: body });
    const again = await t.app.inject({ method: 'POST', url: '/api/v1/payment-intents', payload: body });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect((again.json() as Intent).id).toBe((first.json() as Intent).id);

    const differentAmount = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payment-intents',
      payload: { ...body, amount: '1' },
    });
    expect(differentAmount.statusCode).toBe(409);
    expect(errorCode(differentAmount)).toBe('intent_conflict');

    const sameKeyOtherRef = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payment-intents',
      payload: { ...body, ref: freshRef() },
    });
    expect(sameKeyOtherRef.statusCode).toBe(409);
    expect(errorCode(sameKeyOtherRef)).toBe('intent_conflict');
  });

  it('only allows active members, the tab network and exact safe Luna amounts', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ payer: addr(cy) }, 422, 'not_member'],
      [{ recipient: addr(cy) }, 422, 'not_member'],
      [{ recipient: addr(bo) }, 422, 'invalid_request'],
      [{ network: 5 }, 422, 'network_mismatch'],
      [{ amount: '0' }, 422, 'invalid_body'],
      [{ amount: '1.5' }, 422, 'invalid_body'],
      [{ amount: 100 }, 422, 'invalid_body'],
      [{ amount: '9007199254740992' }, 422, 'invalid_body'],
      [{ ref: 'TOOSHORT' }, 422, 'invalid_body'],
      [{ tabId: 'b'.repeat(26) }, 404, 'tab_not_found'],
    ];
    for (const [override, status, code] of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/payment-intents', payload: intentBody(override) });
      expect([res.statusCode, errorCode(res)], JSON.stringify(override)).toEqual([status, code]);
    }
    const max = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payment-intents',
      payload: intentBody({ amount: '9007199254740991' }),
    });
    expect(max.statusCode).toBe(201);
  });

  it('lists a tab’s intents newest first', async () => {
    const a = await createIntent();
    const b = await createIntent();
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/payment-intents` });
    const ids = (res.json() as { intents: Intent[] }).intents.map((i) => i.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});

describe('submission', () => {
  it('records the hash once, is idempotent, and refuses a different hash', async () => {
    const intent = await createIntent();
    const hash = freshHash();
    const first = await submit(intent.id, hash);
    expect(first.statusCode).toBe(200);
    expect((first.json() as Intent).state).toBe('submitted');
    expect((await submit(intent.id, hash)).statusCode).toBe(200);

    const other = await submit(intent.id, freshHash());
    expect(other.statusCode).toBe(409);
    expect(errorCode(other)).toBe('hash_conflict');

    const second = await createIntent();
    const reused = await submit(second.id, hash);
    expect(reused.statusCode).toBe(409);
    expect(errorCode(reused)).toBe('hash_conflict');
  });

  it('checks the chain right after submission without blocking on it', async () => {
    const intent = await createIntent();
    const hash = freshHash();
    chainTx(intent, hash);
    await submit(intent.id, hash);
    await settled(intent.id, (r) => r.state === 'confirmed');
    const after = await getIntent(intent.id);
    expect(after.verification.status).toBe('confirmed');
    expect(after.observations?.[0]?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still answers when the chain is down', async () => {
    t.chain.down = true;
    const intent = await createIntent();
    const res = await submit(intent.id, freshHash());
    expect(res.statusCode).toBe(200);
    await settled(intent.id, (r) => r.check_count === 1);
    const after = await getIntent(intent.id);
    expect(after.state).toBe('submitted');
    expect(after.verification.status).toBe('unknown');
  });

  it('marks a created intent unknown, and nothing else', async () => {
    const intent = await createIntent();
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/payment-intents/${intent.id}/unknown` });
    expect((res.json() as Intent).state).toBe('unknown');
    const again = await t.app.inject({ method: 'POST', url: `/api/v1/payment-intents/${intent.id}/unknown` });
    expect(again.statusCode).toBe(200);

    const resubmitted = await submit(intent.id, freshHash());
    expect((resubmitted.json() as Intent).state).toBe('submitted');
    const late = await t.app.inject({ method: 'POST', url: `/api/v1/payment-intents/${intent.id}/unknown` });
    expect(late.statusCode).toBe(409);
    expect(errorCode(late)).toBe('invalid_state');
  });

  it('404s unknown intents and 400s malformed ids', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/payment-intents/00000000-0000-4000-8000-000000000000' });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe('intent_not_found');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/payment-intents/nope' })).statusCode).toBe(400);
  });
});

describe('verification', () => {
  async function submittedIntent(): Promise<{ intent: Intent; hash: string }> {
    t.chain.down = true;
    const intent = await createIntent();
    const hash = freshHash();
    await submit(intent.id, hash);
    await settled(intent.id, (r) => r.check_count >= 1);
    t.chain.down = false;
    return { intent, hash };
  }

  it('confirms a matching transaction past its finality block', async () => {
    const { intent, hash } = await submittedIntent();
    chainTx(intent, hash, { blockNumber: 600 });
    t.chain.head = 700;
    const res = await verify(hash);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'confirmed',
      reason: null,
      blockNumber: 600,
      headHeight: 700,
      finalityHeight: 600,
      explorerUrl: `https://nimiq.watch/#${hash}`,
      checkedAt: expect.any(String),
    });
    expect((await getIntent(intent.id)).state).toBe('confirmed');
  });

  it('reports observed before finality', async () => {
    const { intent, hash } = await submittedIntent();
    chainTx(intent, hash, { blockNumber: 650 });
    t.chain.head = 655;
    const body = (await verify(hash)).json() as { status: string; finalityHeight: number };
    expect(body.status).toBe('observed');
    expect(body.finalityHeight).toBe(660);
    expect((await getIntent(intent.id)).state).toBe('observed');
  });

  it('reports pending when the chain does not know the hash', async () => {
    const { intent, hash } = await submittedIntent();
    const body = (await verify(hash)).json() as { status: string; blockNumber: number | null };
    expect(body).toMatchObject({ status: 'pending', blockNumber: null });
    expect((await getIntent(intent.id)).state).toBe('submitted');
  });

  it('reports a mismatch when the amount differs', async () => {
    const { intent, hash } = await submittedIntent();
    chainTx(intent, hash, { value: 1 });
    expect(((await verify(hash)).json() as { status: string }).status).toBe('mismatch');
    expect((await getIntent(intent.id)).state).toBe('mismatch');
  });

  it('reports failed when execution failed', async () => {
    const { intent, hash } = await submittedIntent();
    chainTx(intent, hash, { executionResult: false });
    expect(((await verify(hash)).json() as { status: string }).status).toBe('failed');
    expect((await getIntent(intent.id)).state).toBe('failed');
  });

  it('answers unknown, never confirmed, when the RPC is down', async () => {
    const { intent, hash } = await submittedIntent();
    chainTx(intent, hash);
    t.chain.down = true;
    const res = await verify(hash);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('unknown');
    expect(body.reason).toMatch(/RPC unavailable/);
    expect((await getIntent(intent.id)).state).toBe('submitted');
  });

  it('verifies a PAYMENT_RECORD claim from the replayed log', async () => {
    const salt = 'cd'.repeat(16);
    const ref = paymentRef(addr(bo), salt);
    const hash = freshHash();
    builder.add(bo, 'PAYMENT_RECORD', { recipient: addr(ada), amount: '2500', txHash: hash, salt, network: 24 });
    expect((await append(t.app, tabId, [...builder.log.all()])).json()).toMatchObject({ accepted: 1 });
    t.chain.txs.set(hash, {
      hash,
      from: toUserFriendly(addr(bo)),
      to: toUserFriendly(addr(ada)),
      value: 2500,
      recipientData: utf8Hex(paymentMemo(genesisHash, ref)),
      networkId: 24,
      blockNumber: 120,
      executionResult: true,
    });
    t.chain.head = 200;
    expect(((await verify(hash)).json() as { status: string }).status).toBe('confirmed');
    const { rows } = await db.pool.query('SELECT status, intent_id FROM payment_observations WHERE tx_hash = $1', [hash]);
    expect(rows).toEqual([{ status: 'confirmed', intent_id: null }]);
  });

  it('404s a hash nobody in the tab claims', async () => {
    const res = await verify(freshHash());
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('claim_not_found');
  });
});

describe('reconciler', () => {
  it('moves due intents forward and never regresses a terminal state', async () => {
    t.chain.down = true;
    const intent = await createIntent();
    const hash = freshHash();
    await submit(intent.id, hash);
    await settled(intent.id, (r) => r.check_count >= 1);
    t.chain.down = false;

    const makeDue = () => db.pool.query('UPDATE payment_intents SET next_check_at = now() WHERE id = $1', [intent.id]);

    chainTx(intent, hash, { blockNumber: 650 });
    t.chain.head = 655;
    await makeDue();
    await t.reconciler.tick();
    expect((await getIntent(intent.id)).state).toBe('observed');

    t.chain.head = 660;
    await makeDue();
    await t.reconciler.tick();
    expect((await getIntent(intent.id)).state).toBe('confirmed');

    const before = await db.pool.query('SELECT count(*)::int AS n FROM payment_observations WHERE intent_id = $1', [intent.id]);
    chainTx(intent, hash, { value: 1 });
    await makeDue();
    expect(await t.reconciler.tick()).toBe(0);
    await t.reconciler.checkIntent(intent.id);
    const verified = await verify(hash);
    expect((verified.json() as { status: string }).status).toBe('mismatch');
    const after = await getIntent(intent.id);
    expect(after.state).toBe('confirmed');
    const count = await db.pool.query('SELECT count(*)::int AS n FROM payment_observations WHERE intent_id = $1', [intent.id]);
    expect(count.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('leaves state alone and backs off when the RPC errors', async () => {
    t.chain.down = true;
    const intent = await createIntent();
    await submit(intent.id, freshHash());
    await settled(intent.id, (r) => r.check_count >= 1);
    const { rows } = await db.pool.query<{ state: string; delay: number }>(
      'SELECT state, extract(epoch FROM next_check_at - last_checked_at)::float AS delay FROM payment_intents WHERE id = $1',
      [intent.id],
    );
    expect(rows[0]?.state).toBe('submitted');
    expect(rows[0]?.delay).toBeCloseTo(15, 0);
  });

  it('refuses to edit append-only observations', async () => {
    await expect(db.pool.query("UPDATE payment_observations SET status = 'confirmed'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM entries')).rejects.toThrow(/append-only/);
  });
});
