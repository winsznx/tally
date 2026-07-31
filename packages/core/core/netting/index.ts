/**
 * Tally netting engine — PRD 3.2.
 *
 * Pass 1: pairwise collapse. Pass 2: exact cycle cancellation. Pass 3: greedy
 * min-transfer matching (skipped in 'pairwise' mode).
 *
 * Amounts are Luna as bigint. Participants are 20-byte addresses as 40-char
 * lowercase hex; their lexicographic order IS the canonical byte order, and
 * every tie in this module breaks by that order, never by insertion order.
 */

/** 20 address bytes as 40 lowercase hex chars. Lexicographic order == byte order. */
export type AddressHex = string;

export interface Obligation {
  debtor: AddressHex;
  creditor: AddressHex;
  /** Luna. Must be a positive bigint — never a float, never NIM. */
  amount: bigint;
}

export interface Transfer {
  from: AddressHex;
  to: AddressHex;
  amount: bigint;
}

export interface PositionEntry {
  address: AddressHex;
  /** Negative = owes (debtor), positive = is owed (creditor), zero = settled. */
  position: bigint;
}

export type NettingMode = 'minimal' | 'pairwise';

export interface SettlementPlan {
  mode: NettingMode;
  /** Sorted by address bytes. */
  participants: AddressHex[];
  /** Net positions before settlement, in participant order. Sums to 0n. */
  positions: PositionEntry[];
  /** Deterministic order: greedy emission order in 'minimal', (from, to) sorted in 'pairwise'. */
  transfers: Transfer[];
}

/** Thrown when a production invariant fails. If this ever throws, settlement must halt. */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

const ADDRESS_RE = /^[0-9a-f]{40}$/;

/**
 * Largest amount the settlement layer can carry safely. @nimiq/core accepts
 * bigint values up to 2^64-1 but wraps mod 2^64 above that with no error, so a
 * commitment could bind a plan the execution layer silently corrupts. We cap
 * at Number.MAX_SAFE_INTEGER (2^53-1) — comfortably above Nimiq's total supply
 * (~2.1e15 Luna) and the point past which decimal amounts stop round-tripping
 * cleanly through JSON/Number in the log and UI layers.
 */
export const MAX_LUNA = 9007199254740991n;

/**
 * Largest block height the settlement layer can carry. `validityStartHeight`
 * is a u32 in @nimiq/core, which wraps mod 2^32 with no error (2^32 becomes 0),
 * so a ROUND_OPEN anchor height above this would silently corrupt every leg's
 * validity window. Shared here — the common leaf module — so log and tx reject
 * the same ceiling.
 */
export const MAX_ANCHOR_HEIGHT = 0xffffffff;

export function normalizeAddress(address: string): AddressHex {
  if (typeof address !== 'string') throw new TypeError('address must be a string');
  const a = address.toLowerCase();
  if (!ADDRESS_RE.test(a)) {
    throw new TypeError(`address must be 40 hex chars (20 address bytes), got "${address}"`);
  }
  return a;
}

function assertLuna(value: bigint, what: string): void {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${what} must be a bigint amount in Luna, got ${typeof value}`);
  }
  if (value <= 0n) throw new RangeError(`${what} must be positive, got ${value}`);
  if (value > MAX_LUNA) throw new RangeError(`${what} exceeds MAX_LUNA (${MAX_LUNA}), got ${value}`);
}

interface Edge {
  from: AddressHex;
  to: AddressHex;
  amount: bigint;
}

/** Pass 1: net every unordered pair down to at most one directed edge. */
function pairwiseCollapse(obligations: Obligation[]): Edge[] {
  const pairNet = new Map<string, bigint>();
  for (const ob of obligations) {
    const [lo, hi] = ob.debtor < ob.creditor ? [ob.debtor, ob.creditor] : [ob.creditor, ob.debtor];
    const key = `${lo}|${hi}`;
    // Signed convention: positive means lo owes hi.
    const delta = ob.debtor === lo ? ob.amount : -ob.amount;
    pairNet.set(key, (pairNet.get(key) ?? 0n) + delta);
  }
  const edges: Edge[] = [];
  for (const key of [...pairNet.keys()].sort()) {
    const net = pairNet.get(key) ?? 0n;
    if (net === 0n) continue;
    const [lo, hi] = key.split('|') as [AddressHex, AddressHex];
    edges.push(net > 0n ? { from: lo, to: hi, amount: net } : { from: hi, to: lo, amount: -net });
  }
  return edges;
}

type Adjacency = Map<AddressHex, Map<AddressHex, bigint>>;

function toAdjacency(edges: Edge[]): Adjacency {
  const adj: Adjacency = new Map();
  for (const e of edges) {
    let row = adj.get(e.from);
    if (!row) {
      row = new Map();
      adj.set(e.from, row);
    }
    row.set(e.to, (row.get(e.to) ?? 0n) + e.amount);
  }
  return adj;
}

/** Deterministic DFS: nodes and neighbors visited in address order. */
function findCycle(nodes: AddressHex[], adj: Adjacency): AddressHex[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<AddressHex, number>();
  const path: AddressHex[] = [];
  let found: AddressHex[] | null = null;

  const visit = (node: AddressHex): boolean => {
    color.set(node, GRAY);
    path.push(node);
    const targets = [...(adj.get(node)?.keys() ?? [])].sort();
    for (const t of targets) {
      const c = color.get(t) ?? WHITE;
      if (c === GRAY) {
        found = path.slice(path.indexOf(t));
        return true;
      }
      if (c === WHITE && visit(t)) return true;
    }
    color.set(node, BLACK);
    path.pop();
    return false;
  };

  for (const start of nodes) {
    if ((color.get(start) ?? WHITE) === WHITE && visit(start)) return found;
  }
  return null;
}

/**
 * Pass 2: subtract the minimum edge weight around every directed cycle until
 * the graph is acyclic. Exact — net positions are unchanged, no money moves.
 * Each round removes at least one edge, so this terminates.
 */
function cancelCycles(nodes: AddressHex[], adj: Adjacency): void {
  for (;;) {
    const cycle = findCycle(nodes, adj);
    if (!cycle) return;
    let min: bigint | null = null;
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i] as AddressHex;
      const to = cycle[(i + 1) % cycle.length] as AddressHex;
      const w = adj.get(from)?.get(to);
      if (w === undefined) throw new InvariantViolation('cycle references a missing edge');
      if (min === null || w < min) min = w;
    }
    if (min === null || min <= 0n) throw new InvariantViolation('cycle with non-positive minimum weight');
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i] as AddressHex;
      const to = cycle[(i + 1) % cycle.length] as AddressHex;
      const row = adj.get(from) as Map<AddressHex, bigint>;
      const rest = (row.get(to) as bigint) - min;
      if (rest === 0n) row.delete(to);
      else row.set(to, rest);
    }
  }
}

function positionsFrom(participants: AddressHex[], adj: Adjacency): Map<AddressHex, bigint> {
  const pos = new Map<AddressHex, bigint>();
  for (const p of participants) pos.set(p, 0n);
  for (const from of [...adj.keys()].sort()) {
    const row = adj.get(from) as Map<AddressHex, bigint>;
    for (const to of [...row.keys()].sort()) {
      const amount = row.get(to) as bigint;
      pos.set(from, (pos.get(from) as bigint) - amount);
      pos.set(to, (pos.get(to) as bigint) + amount);
    }
  }
  return pos;
}

/**
 * Pass 3: repeatedly match the largest debtor with the largest creditor.
 * Ties in magnitude break by address bytes ascending — the scan runs in
 * address order and only a strictly larger magnitude displaces the champion,
 * so among equals the smallest address wins. Yields at most n-1 transfers.
 */
function greedyMinimise(sortedParticipants: AddressHex[], positions: Map<AddressHex, bigint>): Transfer[] {
  const work = sortedParticipants.map((address) => ({ address, position: positions.get(address) as bigint }));
  const transfers: Transfer[] = [];
  for (;;) {
    let debtor: { address: AddressHex; position: bigint } | null = null;
    let creditor: { address: AddressHex; position: bigint } | null = null;
    for (const p of work) {
      if (p.position < 0n && (debtor === null || p.position < debtor.position)) debtor = p;
      if (p.position > 0n && (creditor === null || p.position > creditor.position)) creditor = p;
    }
    if (debtor === null && creditor === null) return transfers;
    if (debtor === null || creditor === null) {
      throw new InvariantViolation('positions do not sum to zero: lone debtor or creditor remains');
    }
    const amount = -debtor.position < creditor.position ? -debtor.position : creditor.position;
    transfers.push({ from: debtor.address, to: creditor.address, amount });
    debtor.position += amount;
    creditor.position -= amount;
  }
}

function assertPlanInvariants(plan: SettlementPlan): void {
  const n = plan.participants.length;
  const memberSet = new Set(plan.participants);

  let sum = 0n;
  for (const { position } of plan.positions) sum += position;
  if (sum !== 0n) throw new InvariantViolation(`net positions sum to ${sum}, expected 0`);

  const bound = plan.mode === 'minimal' ? BigInt(Math.max(0, n - 1)) : (BigInt(n) * BigInt(n - 1)) / 2n;
  if (BigInt(plan.transfers.length) > bound) {
    throw new InvariantViolation(`${plan.transfers.length} transfers exceeds bound ${bound} for mode ${plan.mode}`);
  }

  const sim = new Map<AddressHex, bigint>(plan.positions.map((p) => [p.address, p.position]));
  for (const t of plan.transfers) {
    if (t.from === t.to) throw new InvariantViolation(`self-transfer for ${t.from}`);
    if (typeof t.amount !== 'bigint' || t.amount <= 0n) {
      throw new InvariantViolation(`non-positive transfer amount ${t.amount}`);
    }
    if (!memberSet.has(t.from) || !memberSet.has(t.to)) {
      throw new InvariantViolation('transfer references a non-participant');
    }
    sim.set(t.from, (sim.get(t.from) as bigint) + t.amount);
    sim.set(t.to, (sim.get(t.to) as bigint) - t.amount);
  }
  for (const [address, residual] of sim) {
    if (residual !== 0n) {
      throw new InvariantViolation(`applying the plan leaves ${address} at ${residual}, expected 0`);
    }
  }
}

function validateInputs(participants: string[], obligations: Obligation[]): AddressHex[] {
  if (participants.length === 0) throw new RangeError('at least one participant required');
  const normalized = participants.map(normalizeAddress);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw new RangeError('duplicate participant address');
  for (const ob of obligations) {
    assertLuna(ob.amount, 'obligation amount');
    const debtor = normalizeAddress(ob.debtor);
    const creditor = normalizeAddress(ob.creditor);
    if (debtor === creditor) throw new RangeError('obligation debtor equals creditor');
    if (!unique.has(debtor) || !unique.has(creditor)) {
      throw new RangeError('obligation references a non-participant');
    }
  }
  return [...unique].sort();
}

/** Net positions after passes 1–2 (identical to positions after pass 1 alone). */
export function netPositions(participants: string[], obligations: Obligation[]): PositionEntry[] {
  const sorted = validateInputs(participants, obligations);
  const normalized = obligations.map((ob) => ({
    debtor: normalizeAddress(ob.debtor),
    creditor: normalizeAddress(ob.creditor),
    amount: ob.amount,
  }));
  const adj = toAdjacency(pairwiseCollapse(normalized));
  const pos = positionsFrom(sorted, adj);
  return sorted.map((address) => ({ address, position: pos.get(address) as bigint }));
}

/**
 * Compute the settlement plan. Pure: the output is a function of the inputs
 * alone, independent of array order, map order, clock, or locale. All five
 * production invariants are asserted on every call.
 */
export function computePlan(
  participants: string[],
  obligations: Obligation[],
  mode: NettingMode = 'minimal',
): SettlementPlan {
  if (mode !== 'minimal' && mode !== 'pairwise') throw new RangeError(`unknown mode "${String(mode)}"`);
  const sorted = validateInputs(participants, obligations);
  const normalized = obligations.map((ob) => ({
    debtor: normalizeAddress(ob.debtor),
    creditor: normalizeAddress(ob.creditor),
    amount: ob.amount,
  }));

  const adj = toAdjacency(pairwiseCollapse(normalized));
  cancelCycles(sorted, adj);
  const positions = positionsFrom(sorted, adj);

  let transfers: Transfer[];
  if (mode === 'pairwise') {
    transfers = [];
    for (const from of [...adj.keys()].sort()) {
      const row = adj.get(from) as Map<AddressHex, bigint>;
      for (const to of [...row.keys()].sort()) {
        transfers.push({ from, to, amount: row.get(to) as bigint });
      }
    }
  } else {
    transfers = greedyMinimise(sorted, positions);
  }

  const plan: SettlementPlan = {
    mode,
    participants: sorted,
    positions: sorted.map((address) => ({ address, position: positions.get(address) as bigint })),
    transfers,
  };
  assertPlanInvariants(plan);
  return plan;
}
