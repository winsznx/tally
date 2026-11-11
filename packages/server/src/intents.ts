import { paymentMemo } from '@tally/core/log';
import type { ChainCheck, ClaimToCheck } from './chain.js';
import { isUniqueViolation, withTransaction, type Pool, type Queryable } from './db.js';
import { ApiError } from './errors.js';
import { getTab, replayTab } from './ledger.js';

export type IntentState = 'created' | 'submitted' | 'observed' | 'confirmed' | 'failed' | 'mismatch' | 'unknown';

const TERMINAL: ReadonlySet<IntentState> = new Set(['confirmed', 'failed', 'mismatch']);
const BACKOFF_CAP_MS = 10 * 60_000;

export const isTerminal = (state: IntentState): boolean => TERMINAL.has(state);

export interface IntentRow {
  id: string;
  tab_id: string;
  payer: string;
  recipient: string;
  amount: string;
  ref: string;
  memo: string;
  genesis_hash: string;
  network: 5 | 24;
  tx_hash: string | null;
  state: IntentState;
  idempotency_key: string;
  block_number: string | null;
  last_status: string | null;
  last_reason: string | null;
  created_at: Date;
  updated_at: Date;
  last_checked_at: Date | null;
  next_check_at: Date | null;
  check_count: number;
}

export interface IntentJson {
  id: string;
  tabId: string;
  payer: string;
  recipient: string;
  amount: string;
  ref: string;
  memo: string;
  network: 5 | 24;
  txHash: string | null;
  state: IntentState;
  idempotencyKey: string;
  blockNumber: number | null;
  checkCount: number;
  createdAt: string;
  updatedAt: string;
  verification: { status: string | null; reason: string | null; checkedAt: string | null };
}

export function intentJson(row: IntentRow): IntentJson {
  return {
    id: row.id,
    tabId: row.tab_id,
    payer: row.payer,
    recipient: row.recipient,
    amount: row.amount,
    ref: row.ref,
    memo: row.memo,
    network: row.network,
    txHash: row.tx_hash,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    checkCount: row.check_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    verification: {
      status: row.last_status,
      reason: row.last_reason,
      checkedAt: row.last_checked_at?.toISOString() ?? null,
    },
  };
}

export function claimOf(row: IntentRow): ClaimToCheck & { txHash: string } {
  if (row.tx_hash === null) throw new Error(`intent ${row.id} has no transaction hash`);
  return { recipient: row.recipient, amount: BigInt(row.amount), txHash: row.tx_hash, ref: row.ref, network: row.network };
}

/**
 * The only way an intent's state moves after submission. Terminal states never
 * change, and nothing moves backwards: `pending` and `unknown` leave the state as is.
 */
export function nextState(current: IntentState, check: ChainCheck['status']): IntentState {
  if (isTerminal(current)) return current;
  switch (check) {
    case 'confirmed':
    case 'failed':
    case 'mismatch':
      return check;
    case 'observed':
      return 'observed';
    case 'pending':
    case 'unknown':
      return current;
  }
}

export function backoffMs(checkCount: number, baseMs: number): number {
  return Math.min(BACKOFF_CAP_MS, baseMs * 2 ** Math.max(0, Math.min(checkCount - 1, 16)));
}

export async function getIntent(q: Queryable, id: string): Promise<IntentRow | null> {
  const { rows } = await q.query<IntentRow>('SELECT * FROM payment_intents WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function requireIntent(q: Queryable, id: string): Promise<IntentRow> {
  const row = await getIntent(q, id);
  if (!row) throw new ApiError(404, 'intent_not_found', 'no such payment intent');
  return row;
}

export async function listIntents(q: Queryable, tabId: string): Promise<IntentRow[]> {
  const { rows } = await q.query<IntentRow>(
    'SELECT * FROM payment_intents WHERE tab_id = $1 ORDER BY created_at DESC, id DESC',
    [tabId],
  );
  return rows;
}

export interface CreateIntentInput {
  tabId: string;
  payer: string;
  recipient: string;
  amount: string;
  ref: string;
  network: 5 | 24;
  idempotencyKey: string;
}

const sameIntent = (row: IntentRow, input: CreateIntentInput): boolean =>
  row.payer === input.payer &&
  row.recipient === input.recipient &&
  row.amount === input.amount &&
  row.ref === input.ref &&
  row.network === input.network &&
  row.idempotency_key === input.idempotencyKey;

export async function createIntent(pool: Pool, input: CreateIntentInput): Promise<{ intent: IntentRow; created: boolean }> {
  const tab = await getTab(pool, input.tabId);
  if (!tab) throw new ApiError(404, 'tab_not_found', 'no such tab');
  if (tab.network !== input.network) {
    throw new ApiError(422, 'network_mismatch', `this tab is on network ${tab.network}`);
  }
  const { state } = await replayTab(pool, input.tabId);
  if (state.genesisHash === null) throw new ApiError(422, 'ledger_not_open', 'this tab has no valid LEDGER_OPEN entry');
  const active = new Set(state.members.filter((m) => m.active).map((m) => m.address));
  if (!active.has(input.payer)) throw new ApiError(422, 'not_member', 'payer is not an active member of this tab');
  if (!active.has(input.recipient)) throw new ApiError(422, 'not_member', 'recipient is not an active member of this tab');
  if (input.payer === input.recipient) throw new ApiError(422, 'invalid_request', 'payer and recipient must differ');

  const inserted = await pool.query<IntentRow>(
    `INSERT INTO payment_intents (tab_id, payer, recipient, amount, ref, memo, genesis_hash, network, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.tabId,
      input.payer,
      input.recipient,
      input.amount,
      input.ref,
      paymentMemo(state.genesisHash, input.ref),
      state.genesisHash,
      input.network,
      input.idempotencyKey,
    ],
  );
  const row = inserted.rows[0];
  if (row) return { intent: row, created: true };

  const existing = await pool.query<IntentRow>(
    'SELECT * FROM payment_intents WHERE tab_id = $1 AND (ref = $2 OR idempotency_key = $3)',
    [input.tabId, input.ref, input.idempotencyKey],
  );
  const match = existing.rows.length === 1 ? existing.rows[0] : undefined;
  if (match && sameIntent(match, input)) return { intent: match, created: false };
  throw new ApiError(409, 'intent_conflict', 'an intent with this ref or idempotency key exists with different fields');
}

/** Records the wallet's transaction hash. Returns the row and whether it changed. */
export async function submitTransaction(
  pool: Pool,
  id: string,
  txHash: string,
  leaseMs: number,
): Promise<{ intent: IntentRow; changed: boolean }> {
  try {
    return await withTransaction(pool, async (client) => {
      const { rows } = await client.query<IntentRow>('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) throw new ApiError(404, 'intent_not_found', 'no such payment intent');
      if (row.tx_hash === txHash) return { intent: row, changed: false };
      if (row.tx_hash !== null) throw new ApiError(409, 'hash_conflict', 'this intent already has a different transaction hash');
      if (row.state !== 'created' && row.state !== 'unknown') {
        throw new ApiError(409, 'invalid_state', `cannot submit an intent in state ${row.state}`);
      }
      // next_check_at is leased forward because the caller checks immediately.
      const updated = await client.query<IntentRow>(
        `UPDATE payment_intents
         SET tx_hash = $2, state = 'submitted', updated_at = now(),
             next_check_at = now() + make_interval(secs => $3::double precision / 1000)
         WHERE id = $1 RETURNING *`,
        [id, txHash, leaseMs],
      );
      return { intent: updated.rows[0] as IntentRow, changed: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'payment_intents_tx_hash')) {
      throw new ApiError(409, 'hash_conflict', 'this transaction hash is already attached to another intent');
    }
    throw err;
  }
}

export async function markUnknown(pool: Pool, id: string): Promise<IntentRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<IntentRow>('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [id]);
    const row = rows[0];
    if (!row) throw new ApiError(404, 'intent_not_found', 'no such payment intent');
    if (row.state === 'unknown') return row;
    if (row.state !== 'created') throw new ApiError(409, 'invalid_state', `cannot mark an intent in state ${row.state} unknown`);
    const updated = await client.query<IntentRow>(
      `UPDATE payment_intents SET state = 'unknown', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return updated.rows[0] as IntentRow;
  });
}

export interface ObservationInput {
  intentId: string | null;
  txHash: string;
  network: 5 | 24;
  sourceRpc: string;
  check: ChainCheck;
}

export async function insertObservation(q: Queryable, o: ObservationInput): Promise<void> {
  await q.query(
    `INSERT INTO payment_observations
       (intent_id, tx_hash, network, block_number, head_height, status, reason, source_rpc, payload_digest, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      o.intentId,
      o.txHash,
      o.network,
      o.check.blockNumber,
      o.check.headHeight,
      o.check.status,
      o.check.reason,
      o.sourceRpc,
      o.check.payloadDigest,
      o.check.checkedAt,
    ],
  );
}

export interface ObservationJson {
  status: string;
  reason: string | null;
  blockNumber: number | null;
  headHeight: number | null;
  sourceRpc: string;
  payloadDigest: string | null;
  observedAt: string;
}

export async function latestObservations(q: Queryable, intentId: string, limit: number): Promise<ObservationJson[]> {
  const { rows } = await q.query<{
    status: string;
    reason: string | null;
    block_number: string | null;
    head_height: string | null;
    source_rpc: string;
    payload_digest: string | null;
    observed_at: Date;
  }>(
    `SELECT status, reason, block_number, head_height, source_rpc, payload_digest, observed_at
     FROM payment_observations WHERE intent_id = $1 ORDER BY id DESC LIMIT $2`,
    [intentId, limit],
  );
  return rows.map((r) => ({
    status: r.status,
    reason: r.reason,
    blockNumber: r.block_number === null ? null : Number(r.block_number),
    headHeight: r.head_height === null ? null : Number(r.head_height),
    sourceRpc: r.source_rpc,
    payloadDigest: r.payload_digest,
    observedAt: r.observed_at.toISOString(),
  }));
}

/**
 * Applies one chain check to an intent: always appends an observation, and
 * moves the state forward only when the transition rules allow it.
 */
export async function recordCheck(
  pool: Pool,
  intentId: string,
  check: ChainCheck,
  sourceRpc: string,
  backoffBaseMs: number,
  onTerminalIgnored: (row: IntentRow) => void,
): Promise<IntentRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<IntentRow>('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId]);
    const row = rows[0];
    if (!row || row.tx_hash === null) return null;
    await insertObservation(client, { intentId, txHash: row.tx_hash, network: row.network, sourceRpc, check });
    if (isTerminal(row.state)) {
      onTerminalIgnored(row);
      return row;
    }
    const state = nextState(row.state, check.status);
    const checkCount = row.check_count + 1;
    const updated = await client.query<IntentRow>(
      `UPDATE payment_intents
       SET state = $2,
           block_number = COALESCE($3, block_number),
           last_status = $4,
           last_reason = $5,
           last_checked_at = $6::timestamptz,
           check_count = $7,
           next_check_at = CASE WHEN $8::double precision IS NULL THEN NULL
                                ELSE $6::timestamptz + make_interval(secs => $8::double precision / 1000) END,
           updated_at = CASE WHEN state = $2 THEN updated_at ELSE now() END
       WHERE id = $1 RETURNING *`,
      [
        intentId,
        state,
        check.blockNumber,
        check.status,
        check.reason,
        check.checkedAt,
        checkCount,
        isTerminal(state) ? null : backoffMs(checkCount, backoffBaseMs),
      ],
    );
    return updated.rows[0] as IntentRow;
  });
}
