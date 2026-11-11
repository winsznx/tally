import { entryHash, entryId, type LogEntry } from '@tally/core/log';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LogBuilder,
  addr,
  append,
  createTab,
  createTestApp,
  createTestDatabase,
  mk,
  signAs,
  type TestApp,
  type TestDatabase,
} from './helpers.js';

const ada = mk('a1', 'a2');
const bo = mk('b1', 'b2');
const cy = mk('c1', 'c2');
const dee = mk('d1', 'd2');

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

interface AppendBody {
  accepted: number;
  duplicates: number;
  rejected: { index: number; code: string; message: string }[];
}

describe('tabs', () => {
  it('creates a tab with an unguessable id and reports it empty', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/tabs', payload: { network: 24 } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tabId: string; network: number; createdAt: string };
    expect(body.tabId).toMatch(/^[a-z2-7]{26}$/);
    expect(body.network).toBe(24);
    const got = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${body.tabId}` });
    expect(got.json()).toEqual({ tabId: body.tabId, network: 24, createdAt: body.createdAt, entryCount: 0, headSeq: null });
  });

  it('rejects a network other than the configured one', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/tabs', payload: { network: 5 } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: { code: 'network_mismatch', message: expect.any(String) } });
  });

  it('validates the tab id before querying and 404s unknown tabs', async () => {
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/tabs/NOT-A-TAB' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('invalid_tab_id');
    const missing = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${'a'.repeat(26)}` });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('tab_not_found');
  });
});

describe('appending entries', () => {
  let tabId: string;
  let b: LogBuilder;

  beforeAll(async () => {
    tabId = await createTab(t.app);
    b = LogBuilder.tab(ada, bo, cy);
  });

  it('accepts a valid signed log and serves it back in order with server-computed ids', async () => {
    const res = await append(t.app, tabId, [...b.log.all()]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 3, duplicates: 0, rejected: [] });

    const page = (await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/entries` })).json() as {
      entries: { seq: string; entryId: string; entryHash: string; entryJson: string }[];
      nextAfter: string | null;
    };
    expect(page.nextAfter).toBeNull();
    expect(page.entries.map((e) => e.entryId)).toEqual(b.log.all().map((e) => entryId(e)));
    expect(page.entries.map((e) => e.entryHash)).toEqual(b.log.all().map((e) => entryHash(e)));
    expect(JSON.parse(page.entries[0]?.entryJson ?? '{}')).toEqual(b.log.all()[0]);
    const seqs = page.entries.map((e) => BigInt(e.seq));
    expect(seqs).toEqual([...seqs].sort((x, y) => (x < y ? -1 : 1)));
  });

  it('treats a repeated append as duplicates, not new entries', async () => {
    const res = await append(t.app, tabId, [...b.log.all()]);
    expect(res.json()).toEqual({ accepted: 0, duplicates: 3, rejected: [] });
    const tab = (await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}` })).json() as { entryCount: number };
    expect(tab.entryCount).toBe(3);
  });

  it('ignores client-supplied hash fields by rejecting unknown keys', async () => {
    const e = b.add(ada, 'OBLIGATION_PROPOSE', { debtor: addr(bo), creditor: addr(ada), amount: '1000' });
    const res = await append(t.app, tabId, [{ ...e, entryHash: 'f'.repeat(64) }]);
    expect((res.json() as AppendBody).rejected).toEqual([{ index: 0, code: 'invalid_entry', message: expect.any(String) }]);
    expect((await append(t.app, tabId, [e])).json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
  });

  it('rejects a forged signature and a tampered payload', async () => {
    const e = b.add(bo, 'OBLIGATION_PROPOSE', { debtor: addr(bo), creditor: addr(cy), amount: '500' });
    const flipped = e.purseSignature.startsWith('0') ? `1${e.purseSignature.slice(1)}` : `0${e.purseSignature.slice(1)}`;
    const forged = { ...e, purseSignature: flipped };
    const tampered = { ...e, payload: { ...e.payload, amount: '5000' } };
    const res = await append(t.app, tabId, [forged, tampered]);
    const body = res.json() as AppendBody;
    expect(body.accepted).toBe(0);
    expect(body.rejected.map((r) => [r.index, r.code])).toEqual([
      [0, 'bad_signature'],
      [1, 'bad_signature'],
    ]);
  });

  it('rejects entries from someone who never joined', async () => {
    const e = signAs(
      dee,
      'OBLIGATION_PROPOSE',
      { debtor: addr(ada), creditor: addr(dee), amount: '100' },
      { prevEntryHash: b.log.headHash, logicalClock: b.log.length },
    );
    const body = (await append(t.app, tabId, [e])).json() as AppendBody;
    expect(body.rejected).toEqual([{ index: 0, code: 'not_member', message: expect.any(String) }]);
  });

  it('rejects an entry from a member signed with a key other than the one they joined with', async () => {
    const impostor = { account: bo.account, session: dee.session };
    const e = signAs(
      impostor,
      'OBLIGATION_PROPOSE',
      { debtor: addr(ada), creditor: addr(bo), amount: '100' },
      { prevEntryHash: b.log.headHash, logicalClock: b.log.length },
    );
    const body = (await append(t.app, tabId, [e])).json() as AppendBody;
    expect(body.rejected.map((r) => r.code)).toEqual(['not_member']);
  });

  it('rejects an entry that sorts before its author joined, as replay would skip it', async () => {
    const open = signAs(ada, 'LEDGER_OPEN', { name: 'Late' }, { prevEntryHash: null, logicalClock: 0 });
    const join = signAs(dee, 'MEMBER_JOIN', {}, { prevEntryHash: entryHash(open), logicalClock: 5 });
    const early = signAs(
      dee,
      'OBLIGATION_PROPOSE',
      { debtor: addr(dee), creditor: addr(ada), amount: '1' },
      { prevEntryHash: entryHash(open), logicalClock: 2 },
    );
    const tab = await createTab(t.app);
    const res = (await append(t.app, tab, [open, join, early])).json() as AppendBody;
    expect(res.accepted).toBe(2);
    expect(res.rejected).toEqual([{ index: 2, code: 'not_member', message: expect.any(String) }]);
  });

  it('rejects a second LEDGER_OPEN and anything before a ledger is open', async () => {
    const other = LogBuilder.tab(bo);
    const body = (await append(t.app, tabId, [other.log.all()[0]])).json() as AppendBody;
    expect(body.rejected.map((r) => r.code)).toEqual(['ledger_already_open']);

    const empty = await createTab(t.app);
    const join = b.log.all()[1] as LogEntry;
    const res = (await append(t.app, empty, [join])).json() as AppendBody;
    expect(res.rejected.map((r) => r.code)).toEqual(['not_member']);
  });

  it('flags the same entryId with different bytes as a conflict', async () => {
    const nonce = 'ab'.repeat(16);
    const payload = { debtor: addr(cy), creditor: addr(ada), amount: '777' };
    const first = signAs(ada, 'OBLIGATION_PROPOSE', payload, { prevEntryHash: b.log.headHash, logicalClock: 40, nonce });
    const second = signAs(ada, 'OBLIGATION_PROPOSE', payload, { prevEntryHash: b.log.headHash, logicalClock: 41, nonce });
    expect(entryId(first)).toBe(entryId(second));
    expect(entryHash(first)).not.toBe(entryHash(second));
    const res = (await append(t.app, tabId, [first, second])).json() as AppendBody;
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([{ index: 1, code: 'conflict', message: expect.any(String) }]);
  });

  it('returns 422 only for a malformed body', async () => {
    for (const payload of [{}, { entries: [] }, { entries: 'x' }, { entries: Array.from({ length: 101 }, () => ({})) }]) {
      const res = await t.app.inject({ method: 'POST', url: `/api/v1/tabs/${tabId}/entries`, payload });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_body');
    }
    const junk = await append(t.app, tabId, [42, null, { prevEntryHash: null }]);
    expect(junk.statusCode).toBe(200);
    expect((junk.json() as AppendBody).rejected.map((r) => r.code)).toEqual(['invalid_entry', 'invalid_entry', 'invalid_entry']);
    const invalidJson = await t.app.inject({
      method: 'POST',
      url: `/api/v1/tabs/${tabId}/entries`,
      headers: { 'content-type': 'application/json' },
      payload: '{"entries": [',
    });
    expect(invalidJson.statusCode).toBe(422);
    expect((invalidJson.json() as { error: { code: string } }).error.code).toBe('invalid_body');
  });

  it('404s an append to an unknown tab', async () => {
    const res = await append(t.app, 'z'.repeat(26), [...b.log.all()]);
    expect(res.statusCode).toBe(404);
  });
});

describe('pagination', () => {
  it('walks the log with after and limit', async () => {
    const tabId = await createTab(t.app);
    const b = LogBuilder.tab(ada, bo, cy, dee);
    b.add(ada, 'OBLIGATION_PROPOSE', { debtor: addr(bo), creditor: addr(ada), amount: '1' });
    await append(t.app, tabId, [...b.log.all()]);

    const seen: string[] = [];
    let after = '0';
    let pages = 0;
    for (;;) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/entries?after=${after}&limit=2` });
      const page = res.json() as { entries: { seq: string; entryId: string }[]; nextAfter: string | null };
      seen.push(...page.entries.map((e) => e.entryId));
      pages += 1;
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(b.log.all().map((e) => entryId(e)));

    for (const q of ['limit=0', 'limit=501', 'after=-1', 'after=abc']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/entries?${q}` });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('concurrent appends', () => {
  it('serialises overlapping batches on one tab', async () => {
    const tabId = await createTab(t.app);
    const b = LogBuilder.tab(ada, bo, cy);
    const [open, joinBo, joinCy] = b.log.all() as [LogEntry, LogEntry, LogEntry];
    const [r1, r2] = await Promise.all([append(t.app, tabId, [open, joinBo]), append(t.app, tabId, [open, joinCy])]);
    const bodies = [r1.json(), r2.json()] as AppendBody[];
    expect(bodies.reduce((n, x) => n + x.accepted, 0)).toBe(3);
    expect(bodies.reduce((n, x) => n + x.duplicates, 0)).toBe(1);
    expect(bodies.flatMap((x) => x.rejected)).toEqual([]);

    const page = (await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/entries` })).json() as {
      entries: { entryId: string }[];
    };
    expect(new Set(page.entries.map((e) => e.entryId))).toEqual(new Set([open, joinBo, joinCy].map((e) => entryId(e))));
  });
});

describe('summary', () => {
  it('derives counts from a replay of stored entries', async () => {
    const tabId = await createTab(t.app);
    const b = LogBuilder.tab(ada, bo, cy);
    const shares = [
      { member: addr(ada), amount: '100' },
      { member: addr(bo), amount: '100' },
      { member: addr(cy), amount: '100' },
    ].sort((x, y) => (x.member < y.member ? -1 : 1));
    b.add(ada, 'EXPENSE_RECORD', { title: 'Dinner', total: '300', method: 'equal', shares });
    b.add(bo, 'OBLIGATION_PROPOSE', { debtor: addr(cy), creditor: addr(bo), amount: '50' });
    await append(t.app, tabId, [...b.log.all()]);

    const res = await t.app.inject({ method: 'GET', url: `/api/v1/tabs/${tabId}/summary` });
    expect(res.json()).toEqual({
      name: 'Weekend',
      memberCount: 3,
      expenseCount: 1,
      obligationCounts: { PROPOSED: 3, ACCEPTED: 0, CONTESTED: 0, CANCELLED: 0, IN_ROUND: 0 },
      paymentCount: 0,
      entryCount: 5,
      headSeq: expect.stringMatching(/^\d+$/),
      cached: true,
    });
  });
});
