/**
 * Tally signed append-only ledger log — PRD 5.5.
 *
 * Every entry is signed by its author's purse key and content-addressed two
 * ways: an **entry ID** `H(authorAddress || nonce || entryType || payload)`
 * that makes duplicates collapse on arrival, and an **entry hash** over the
 * full signed entry including its `prevEntryHash`, so a single head hash
 * identifies the entire history.
 *
 * Replay derives state after sorting by `(logicalClock, entryId)`, so the
 * derived state is independent of arrival order. Contextually invalid entries
 * (non-member author, accept by non-debtor, …) are skipped deterministically
 * and recorded — never silently dropped, never allowed to corrupt state.
 *
 * Note on the entry ID preimage: the PRD writes `H(authorAddress || nonce ||
 * payload)`; this implementation also includes `entryType`, preventing an
 * entry of one type from colliding with an entry of another that happens to
 * share a payload shape.
 */
import { Hash, KeyPair, PublicKey, Signature } from '@nimiq/core';
import { bytesToHex, concatBytes, hexToBytes, utf8 } from '../internal/bytes.js';
import { verifyBindingAttestation } from '../binding/index.js';
import { MAX_ANCHOR_HEIGHT, MAX_LUNA, type AddressHex, type NettingMode, type Obligation } from '../netting/index.js';

export type EntryType =
  | 'LEDGER_OPEN'
  | 'MEMBER_JOIN'
  | 'MEMBER_LEAVE'
  | 'OBLIGATION_PROPOSE'
  | 'OBLIGATION_ACCEPT'
  | 'OBLIGATION_REJECT'
  | 'ROUND_OPEN'
  | 'ROUND_EXPIRE';

const ENTRY_TYPES: ReadonlySet<string> = new Set([
  'LEDGER_OPEN',
  'MEMBER_JOIN',
  'MEMBER_LEAVE',
  'OBLIGATION_PROPOSE',
  'OBLIGATION_ACCEPT',
  'OBLIGATION_REJECT',
  'ROUND_OPEN',
  'ROUND_EXPIRE',
]);

export interface LogEntry {
  /** Entry hash of the predecessor; null only for LEDGER_OPEN. */
  prevEntryHash: string | null;
  entryType: EntryType;
  payload: Record<string, unknown>;
  /** 20-byte account address, 40 lowercase hex. */
  authorAddress: AddressHex;
  /** 32-byte Ed25519 public key, 64 lowercase hex. */
  pursePublicKey: string;
  /** 64-byte Ed25519 signature over the canonical signing bytes, 128 lowercase hex. */
  purseSignature: string;
  /** 16-byte nonce, 32 lowercase hex. Same nonce + payload ⇒ same entry ID. */
  nonce: string;
  /** Lamport-style clock. 0 only for LEDGER_OPEN. */
  logicalClock: number;
}

export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogError';
  }
}

// --- canonical JSON ---------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new LogError(`payload numbers must be safe integers, got ${value} — encode amounts as decimal strings`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const body = keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
        .join(',');
      return `{${body}}`;
    }
    default:
      throw new LogError(`payload contains unserializable ${typeof value}`);
  }
}

// --- hashing and signing ----------------------------------------------------

export function entryId(entry: Pick<LogEntry, 'authorAddress' | 'nonce' | 'entryType' | 'payload'>): string {
  const preimage = concatBytes(
    hexToBytes(entry.authorAddress),
    hexToBytes(entry.nonce),
    utf8(entry.entryType),
    utf8(canonicalJson(entry.payload)),
  );
  return bytesToHex(Hash.computeBlake2b(preimage));
}

/**
 * The exact canonical text an entry's Ed25519 signature covers. Exported so the
 * relay can reconstruct and verify signatures without depending on @nimiq/core
 * (it re-derives this string and checks the signature with Web Crypto). A
 * cross-check test guarantees the relay's copy stays byte-identical to this.
 */
export function entrySigningText(entry: Omit<LogEntry, 'purseSignature'>): string {
  return [
    'tally-log-entry-v1',
    `prev:${entry.prevEntryHash ?? '-'}`,
    `type:${entry.entryType}`,
    `author:${entry.authorAddress}`,
    `pursePk:${entry.pursePublicKey}`,
    `nonce:${entry.nonce}`,
    `clock:${entry.logicalClock}`,
    `payload:${canonicalJson(entry.payload)}`,
  ].join('\n');
}

function signingBytes(entry: Omit<LogEntry, 'purseSignature'>): Uint8Array {
  return utf8(entrySigningText(entry));
}

export function entryHash(entry: LogEntry): string {
  return bytesToHex(
    Hash.computeBlake2b(concatBytes(signingBytes(entry), hexToBytes(entry.purseSignature))),
  );
}

/**
 * A content-derived 16-byte nonce for entries that must COLLAPSE across devices
 * rather than merely avoid forking — ROUND_OPEN and ROUND_EXPIRE. Because the
 * entry ID covers the nonce, a random nonce would make two devices' otherwise
 * identical round entries distinct; deriving the nonce from the content makes
 * them byte-identical so they dedupe on entry ID (GAP 1). User-initiated entries
 * (propose/accept/reject) use a random nonce — they are genuinely distinct acts.
 */
export function deterministicNonce(entryType: EntryType, payload: Record<string, unknown>): string {
  const digest = Hash.computeBlake2b(concatBytes(utf8(entryType), utf8(canonicalJson(payload))));
  return bytesToHex(digest.slice(0, 16));
}

export function signEntry(unsigned: Omit<LogEntry, 'purseSignature'>, keyPair: KeyPair): LogEntry {
  validateUnsigned(unsigned);
  const expectedPk = bytesToHex(keyPair.publicKey.serialize());
  if (expectedPk !== unsigned.pursePublicKey) {
    throw new LogError('pursePublicKey does not match the signing key pair');
  }
  const signature = bytesToHex(keyPair.sign(signingBytes(unsigned)).serialize());
  return { ...unsigned, purseSignature: signature };
}

export function verifyEntrySignature(entry: LogEntry): boolean {
  const { purseSignature, ...unsigned } = entry;
  try {
    return PublicKey.deserialize(hexToBytes(entry.pursePublicKey)).verify(
      Signature.deserialize(hexToBytes(purseSignature)),
      signingBytes(unsigned),
    );
  } catch {
    return false;
  }
}

// --- structural validation --------------------------------------------------

const HEX_RE = (len: number): RegExp => new RegExp(`^[0-9a-f]{${len}}$`);
const ADDR_RE = HEX_RE(40);
const PK_RE = HEX_RE(64);
const SIG_RE = HEX_RE(128);
const NONCE_RE = HEX_RE(32);
const HASH_RE = HEX_RE(64);
const AMOUNT_RE = /^[1-9][0-9]*$/;

function validatePayload(entryType: EntryType, payload: Record<string, unknown>): void {
  const keys = Object.keys(payload).sort();
  const expect = (allowed: string[], required: string[]): void => {
    for (const k of keys) if (!allowed.includes(k)) throw new LogError(`${entryType}: unexpected payload key "${k}"`);
    for (const k of required) if (!(k in payload)) throw new LogError(`${entryType}: missing payload key "${k}"`);
  };
  // LEDGER_OPEN and MEMBER_JOIN register a member, so both carry the binding
  // attestation that proves the entry's purse key speaks for authorAddress (the
  // account). Structural checks here; the signature is verified in replay.
  const requireBindingFields = (): void => {
    if (typeof payload['accountPublicKey'] !== 'string' || !PK_RE.test(payload['accountPublicKey'])) {
      throw new LogError(`${entryType}: accountPublicKey must be 64 lowercase hex chars`);
    }
    if (typeof payload['bindingSignature'] !== 'string' || !SIG_RE.test(payload['bindingSignature'])) {
      throw new LogError(`${entryType}: bindingSignature must be 128 lowercase hex chars`);
    }
  };
  switch (entryType) {
    case 'LEDGER_OPEN':
      expect(['name', 'accountPublicKey', 'bindingSignature'], ['name', 'accountPublicKey', 'bindingSignature']);
      if (typeof payload['name'] !== 'string') throw new LogError('LEDGER_OPEN: name must be a string');
      requireBindingFields();
      return;
    case 'MEMBER_JOIN':
      expect(['accountPublicKey', 'bindingSignature'], ['accountPublicKey', 'bindingSignature']);
      requireBindingFields();
      return;
    case 'MEMBER_LEAVE':
      // Leaving carries no binding — the member is already registered, and the
      // shared purse-key guard proves the entry came from them.
      expect(['reason'], []);
      if ('reason' in payload && typeof payload['reason'] !== 'string') {
        throw new LogError('MEMBER_LEAVE: reason must be a string');
      }
      return;
    case 'OBLIGATION_PROPOSE': {
      expect(['debtor', 'creditor', 'amount', 'memo'], ['debtor', 'creditor', 'amount']);
      const { debtor, creditor, amount } = payload;
      if (typeof debtor !== 'string' || !ADDR_RE.test(debtor)) throw new LogError('PROPOSE: bad debtor address');
      if (typeof creditor !== 'string' || !ADDR_RE.test(creditor)) throw new LogError('PROPOSE: bad creditor address');
      if (debtor === creditor) throw new LogError('PROPOSE: debtor equals creditor');
      if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
        throw new LogError('PROPOSE: amount must be a positive decimal Luna string');
      }
      if (BigInt(amount) > MAX_LUNA) {
        throw new LogError(`PROPOSE: amount exceeds MAX_LUNA (${MAX_LUNA})`);
      }
      if ('memo' in payload && typeof payload['memo'] !== 'string') throw new LogError('PROPOSE: memo must be a string');
      return;
    }
    case 'OBLIGATION_ACCEPT': {
      // observedHeight is the block height the accepting device saw when it
      // signed. It is recorded permanently so ROUND_OPEN can DERIVE its anchor
      // height from the log (GAP 1) rather than observing it at open time —
      // otherwise two devices opening a round at different heights fork the log.
      expect(['proposeId', 'observedHeight'], ['proposeId', 'observedHeight']);
      if (typeof payload['proposeId'] !== 'string' || !HASH_RE.test(payload['proposeId'])) {
        throw new LogError('ACCEPT: proposeId must be a 32-byte entry ID hex');
      }
      const h = payload['observedHeight'];
      if (typeof h !== 'number' || !Number.isSafeInteger(h) || h < 1 || h > MAX_ANCHOR_HEIGHT) {
        throw new LogError(`ACCEPT: observedHeight must be an integer in 1..${MAX_ANCHOR_HEIGHT}`);
      }
      return;
    }
    case 'OBLIGATION_REJECT':
      expect(['proposeId', 'reason'], ['proposeId']);
      if (typeof payload['proposeId'] !== 'string' || !HASH_RE.test(payload['proposeId'])) {
        throw new LogError('REJECT: proposeId must be a 32-byte entry ID hex');
      }
      if ('reason' in payload && typeof payload['reason'] !== 'string') throw new LogError('REJECT: reason must be a string');
      return;
    case 'ROUND_OPEN': {
      expect(['round', 'anchorHeight', 'mode'], ['round', 'anchorHeight', 'mode']);
      const { round, anchorHeight, mode } = payload;
      if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 1) {
        throw new LogError('ROUND_OPEN: round must be an integer >= 1');
      }
      if (typeof anchorHeight !== 'number' || !Number.isSafeInteger(anchorHeight) || anchorHeight < 1) {
        throw new LogError('ROUND_OPEN: anchorHeight must be an integer >= 1');
      }
      if (anchorHeight > MAX_ANCHOR_HEIGHT) {
        throw new LogError(`ROUND_OPEN: anchorHeight exceeds the u32 block-height ceiling (${MAX_ANCHOR_HEIGHT})`);
      }
      if (mode !== 'minimal' && mode !== 'pairwise') throw new LogError('ROUND_OPEN: bad mode');
      return;
    }
    case 'ROUND_EXPIRE':
      expect(['round'], ['round']);
      if (typeof payload['round'] !== 'number' || !Number.isSafeInteger(payload['round']) || payload['round'] < 1) {
        throw new LogError('ROUND_EXPIRE: round must be an integer >= 1');
      }
      return;
  }
}

function validateUnsigned(entry: Omit<LogEntry, 'purseSignature'>): void {
  if (!ENTRY_TYPES.has(entry.entryType)) throw new LogError(`unknown entry type "${String(entry.entryType)}"`);
  if (entry.prevEntryHash !== null && !HASH_RE.test(entry.prevEntryHash)) {
    throw new LogError('prevEntryHash must be null or a 32-byte hash hex');
  }
  if (!ADDR_RE.test(entry.authorAddress)) throw new LogError('authorAddress must be 40 lowercase hex chars');
  if (!PK_RE.test(entry.pursePublicKey)) throw new LogError('pursePublicKey must be 64 lowercase hex chars');
  if (!NONCE_RE.test(entry.nonce)) throw new LogError('nonce must be 32 lowercase hex chars');
  if (!Number.isSafeInteger(entry.logicalClock) || entry.logicalClock < 0) {
    throw new LogError('logicalClock must be a non-negative integer');
  }
  const isOpen = entry.entryType === 'LEDGER_OPEN';
  if (isOpen !== (entry.logicalClock === 0)) {
    throw new LogError('logicalClock 0 is reserved for LEDGER_OPEN');
  }
  if (isOpen !== (entry.prevEntryHash === null)) {
    throw new LogError('prevEntryHash null is reserved for LEDGER_OPEN');
  }
  validatePayload(entry.entryType, entry.payload);
}

export function validateEntry(entry: LogEntry): void {
  validateUnsigned(entry);
  if (!SIG_RE.test(entry.purseSignature)) throw new LogError('purseSignature must be 128 lowercase hex chars');
  if (!verifyEntrySignature(entry)) throw new LogError('entry signature does not verify');
}

// --- replay -----------------------------------------------------------------

export type ObligationStatus = 'PROPOSED' | 'ACCEPTED' | 'CONTESTED' | 'IN_ROUND';

/** Minimal accept facts needed to derive a round's anchor height (GAP 1). */
export interface AcceptedHeightRef {
  acceptId: string | null;
  acceptObservedHeight: number | null;
  acceptClock: number | null;
}

/**
 * The log-derived anchor height for a round: the observedHeight recorded on the
 * canonically-latest consumed accept (max by (acceptClock, acceptId)). Pure and
 * order-independent, so every device building a ROUND_OPEN from the same
 * accepted set produces the identical height — and thus identical bytes.
 * The app must use this to construct ROUND_OPEN; replay rejects any other value.
 */
export function derivedAnchorHeight(consumed: readonly AcceptedHeightRef[]): number {
  let bestId: string | null = null;
  let bestClock = -1;
  let bestHeight = -1;
  for (const ob of consumed) {
    if (ob.acceptObservedHeight === null || ob.acceptClock === null || ob.acceptId === null) continue;
    if (bestId === null || ob.acceptClock > bestClock || (ob.acceptClock === bestClock && ob.acceptId > bestId)) {
      bestId = ob.acceptId;
      bestClock = ob.acceptClock;
      bestHeight = ob.acceptObservedHeight;
    }
  }
  if (bestId === null) throw new LogError('cannot derive anchor height: no accepted obligation with a recorded height');
  return bestHeight;
}

export interface ObligationRecord {
  proposeId: string;
  debtor: AddressHex;
  creditor: AddressHex;
  amount: bigint;
  memo: string | null;
  status: ObligationStatus;
  acceptId: string | null;
  /** Block height recorded on the accepting entry, or null if not yet accepted. */
  acceptObservedHeight: number | null;
  /** logicalClock of the accepting entry, for deterministic anchor-height derivation. */
  acceptClock: number | null;
  /** Round that consumed this obligation, if any. */
  round: number | null;
}

export interface OpenRound {
  round: number;
  anchorHeight: number;
  mode: NettingMode;
  /** Entry IDs of the OBLIGATION_ACCEPT entries consumed by this round, sorted. */
  consumedAcceptIds: string[];
  /** Propose IDs of the obligations consumed by this round, sorted. */
  consumedProposeIds: string[];
}

export interface IgnoredEntry {
  id: string;
  entryType: EntryType;
  reason: string;
}

export interface LedgerState {
  ledgerName: string | null;
  /** Entry hash of LEDGER_OPEN — the ledger genesis hash the anchor tag derives from. */
  genesisHash: string | null;
  /**
   * Sorted by address. A member who has left stays listed with `active:
   * false` — their unsettled edges remain visible and remain in netting until
   * they settle, because the record follows the address (PRD 6).
   */
  members: { address: AddressHex; pursePublicKey: string; active: boolean }[];
  /** All obligations by propose entry ID, sorted by ID. */
  obligations: ObligationRecord[];
  /**
   * The netting input: obligations whose debtor has explicitly signed an
   * acceptance and which no round has consumed. Nothing PROPOSED or CONTESTED
   * ever appears here — silence is never consent.
   */
  acceptedPending: (Obligation & { proposeId: string })[];
  openRound: OpenRound | null;
  lastClosedRound: number;
  /** Contextually invalid entries, skipped deterministically. */
  ignored: IgnoredEntry[];
}

interface SortableEntry {
  entry: LogEntry;
  id: string;
  hash: string;
}

function canonicalOrder(entries: LogEntry[]): SortableEntry[] {
  const seen = new Map<string, SortableEntry>();
  for (const entry of entries) {
    validateEntry(entry);
    const id = entryId(entry);
    const candidate: SortableEntry = { entry, id, hash: entryHash(entry) };
    const existing = seen.get(id);
    // The entry ID covers (author, nonce, type, payload) but not clock, prev,
    // or signature, so two valid entries can share an ID while differing in
    // content. Keeping "whichever arrived first" would make replay depend on
    // arrival order; instead the variant with the smallest entry hash wins —
    // a pure content rule, identical on every device.
    if (!existing || candidate.hash < existing.hash) seen.set(id, candidate);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.entry.logicalClock !== b.entry.logicalClock) return a.entry.logicalClock - b.entry.logicalClock;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Derive ledger state from entries. Pure and order-independent: entries are
 * deduplicated by entry ID and folded in `(logicalClock, entryId)` order, so
 * any permutation of the same set yields identical state.
 */
export function replayState(entries: LogEntry[]): LedgerState {
  const ordered = canonicalOrder(entries);
  const members = new Map<AddressHex, string>();
  const departed = new Set<AddressHex>();
  const obligations = new Map<string, ObligationRecord>();
  const acceptIdByPropose = new Map<string, string>();
  const ignored: IgnoredEntry[] = [];
  let ledgerName: string | null = null;
  let genesisHash: string | null = null;
  let openRound: OpenRound | null = null;
  let lastClosedRound = 0;

  const skip = (s: SortableEntry, reason: string): void => {
    ignored.push({ id: s.id, entryType: s.entry.entryType, reason });
  };

  // The one shared purse-key guard: any entry whose author is already a
  // registered member MUST carry that member's registered purse key. Hoisted
  // above the switch so no present or future handler can forget it.
  const bindingValid = (e: LogEntry): boolean =>
    verifyBindingAttestation({
      accountAddress: e.authorAddress,
      accountPublicKey: e.payload['accountPublicKey'] as string,
      pursePublicKey: e.pursePublicKey,
      bindingSignature: e.payload['bindingSignature'] as string,
    });

  for (const s of ordered) {
    const e = s.entry;
    const registeredPk = members.get(e.authorAddress);
    const hasLeft = departed.has(e.authorAddress);
    // A departed member may re-join with a FRESH purse key — their new
    // MEMBER_JOIN re-attests it, so the binding check below (not the old
    // registration) is what authorises them. Every other entry, from every
    // other author, must carry the purse key registered at join.
    const rejoining = e.entryType === 'MEMBER_JOIN' && hasLeft;
    if (!rejoining && registeredPk !== undefined && registeredPk !== e.pursePublicKey) {
      skip(s, 'purse key does not match the one registered at join');
      continue;
    }
    const isMember = registeredPk !== undefined && !hasLeft;
    // A member who has left keeps their history and their unsettled edges, but
    // cannot author new ledger activity until they re-join.
    if (
      hasLeft &&
      e.entryType !== 'MEMBER_JOIN' &&
      e.entryType !== 'LEDGER_OPEN'
    ) {
      skip(s, 'author has left the ledger');
      continue;
    }
    switch (e.entryType) {
      case 'LEDGER_OPEN': {
        if (genesisHash !== null) {
          skip(s, 'ledger already open');
          break;
        }
        if (!bindingValid(e)) {
          skip(s, 'binding attestation does not verify — purse is not bound to authorAddress');
          break;
        }
        ledgerName = e.payload['name'] as string;
        genesisHash = s.hash;
        members.set(e.authorAddress, e.pursePublicKey);
        break;
      }
      case 'MEMBER_JOIN': {
        if (genesisHash === null) {
          skip(s, 'no ledger open');
          break;
        }
        if (isMember) break; // duplicate join with the registered purse key: no-op
        if (!bindingValid(e)) {
          skip(s, 'binding attestation does not verify — purse is not bound to authorAddress');
          break;
        }
        // A re-join is a NEW membership, never a silent reactivation of the old
        // one: it registers whatever purse key this fresh attestation names.
        members.set(e.authorAddress, e.pursePublicKey);
        departed.delete(e.authorAddress);
        break;
      }
      case 'MEMBER_LEAVE': {
        if (!isMember) {
          skip(s, 'author is not an active member');
          break;
        }
        // Leaving with a non-zero position is allowed and deliberate: the
        // unsettled edge stays visible and stays in netting until it settles.
        // The record follows the address (PRD 6).
        departed.add(e.authorAddress);
        break;
      }
      case 'OBLIGATION_PROPOSE': {
        if (!isMember) {
          skip(s, 'author is not a member');
          break;
        }
        const debtor = e.payload['debtor'] as AddressHex;
        const creditor = e.payload['creditor'] as AddressHex;
        if (e.authorAddress !== debtor && e.authorAddress !== creditor) {
          skip(s, 'proposer is neither debtor nor creditor');
          break;
        }
        if (!members.has(debtor) || !members.has(creditor)) {
          skip(s, 'obligation references a non-member');
          break;
        }
        obligations.set(s.id, {
          proposeId: s.id,
          debtor,
          creditor,
          amount: BigInt(e.payload['amount'] as string),
          memo: (e.payload['memo'] as string | undefined) ?? null,
          status: 'PROPOSED',
          acceptId: null,
          acceptObservedHeight: null,
          acceptClock: null,
          round: null,
        });
        break;
      }
      case 'OBLIGATION_ACCEPT': {
        const ob = obligations.get(e.payload['proposeId'] as string);
        if (!ob) {
          skip(s, 'accept references an unknown obligation');
          break;
        }
        if (e.authorAddress !== ob.debtor) {
          skip(s, 'only the named debtor can accept — silence or third parties never consent');
          break;
        }
        if (ob.status !== 'PROPOSED' && ob.status !== 'CONTESTED') {
          skip(s, `obligation is ${ob.status}, not acceptable`);
          break;
        }
        ob.status = 'ACCEPTED';
        ob.acceptId = s.id;
        ob.acceptObservedHeight = e.payload['observedHeight'] as number;
        ob.acceptClock = e.logicalClock;
        acceptIdByPropose.set(ob.proposeId, s.id);
        break;
      }
      case 'OBLIGATION_REJECT': {
        const ob = obligations.get(e.payload['proposeId'] as string);
        if (!ob) {
          skip(s, 'reject references an unknown obligation');
          break;
        }
        if (e.authorAddress !== ob.debtor) {
          skip(s, 'only the named debtor can reject');
          break;
        }
        if (ob.status !== 'PROPOSED') {
          skip(s, `obligation is ${ob.status}, not rejectable`);
          break;
        }
        ob.status = 'CONTESTED';
        break;
      }
      case 'ROUND_OPEN': {
        if (!isMember) {
          skip(s, 'author is not a member');
          break;
        }
        const round = e.payload['round'] as number;
        if (openRound !== null) {
          skip(s, `round ${openRound.round} is already open`);
          break;
        }
        if (round !== lastClosedRound + 1) {
          skip(s, `round ${round} out of sequence, expected ${lastClosedRound + 1}`);
          break;
        }
        const consumed = [...obligations.values()]
          .filter((ob) => ob.status === 'ACCEPTED')
          .sort((a, b) => (a.proposeId < b.proposeId ? -1 : 1));
        if (consumed.length === 0) {
          skip(s, 'round has no accepted obligations to settle');
          break;
        }
        // GAP 1: the anchor height is DERIVED from the log — the observedHeight
        // of the canonically-latest consumed accept (max (acceptClock, acceptId)).
        // Every device computes the same value, so a ROUND_OPEN's content is
        // byte-identical and duplicates collapse on entry ID. A ROUND_OPEN whose
        // anchorHeight is not this derived value is rejected, which is what stops
        // an observed-at-open height from forking the log.
        const expectedAnchorHeight = derivedAnchorHeight(consumed);
        if ((e.payload['anchorHeight'] as number) !== expectedAnchorHeight) {
          skip(s, `anchorHeight ${e.payload['anchorHeight']} is not the log-derived height ${expectedAnchorHeight}`);
          break;
        }
        for (const ob of consumed) {
          ob.status = 'IN_ROUND';
          ob.round = round;
        }
        openRound = {
          round,
          anchorHeight: expectedAnchorHeight,
          mode: e.payload['mode'] as NettingMode,
          consumedAcceptIds: consumed.map((ob) => ob.acceptId as string).sort(),
          consumedProposeIds: consumed.map((ob) => ob.proposeId),
        };
        break;
      }
      case 'ROUND_EXPIRE': {
        if (!isMember) {
          skip(s, 'author is not a member');
          break;
        }
        const round = e.payload['round'] as number;
        if (openRound === null || openRound.round !== round) {
          skip(s, `round ${round} is not open`);
          break;
        }
        for (const proposeId of openRound.consumedProposeIds) {
          const ob = obligations.get(proposeId);
          if (ob && ob.status === 'IN_ROUND') {
            ob.status = 'ACCEPTED';
            ob.round = null;
          }
        }
        lastClosedRound = round;
        openRound = null;
        break;
      }
    }
  }

  const sortedObligations = [...obligations.values()].sort((a, b) => (a.proposeId < b.proposeId ? -1 : 1));
  return {
    ledgerName,
    genesisHash,
    members: [...members.entries()]
      .map(([address, pursePublicKey]) => ({ address, pursePublicKey, active: !departed.has(address) }))
      .sort((a, b) => (a.address < b.address ? -1 : 1)),
    obligations: sortedObligations,
    acceptedPending: sortedObligations
      .filter((ob) => ob.status === 'ACCEPTED')
      .map((ob) => ({ proposeId: ob.proposeId, debtor: ob.debtor, creditor: ob.creditor, amount: ob.amount })),
    openRound,
    lastClosedRound,
    ignored,
  };
}

// --- linear log, head hash, fork detection ----------------------------------

export class TallyLog {
  private readonly entries: LogEntry[] = [];
  private readonly hashes: string[] = [];
  private readonly byId = new Set<string>();

  get headHash(): string | null {
    return this.hashes.length === 0 ? null : (this.hashes[this.hashes.length - 1] as string);
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }

  chainHashes(): readonly string[] {
    return this.hashes;
  }

  /**
   * Append a signed entry. Verifies structure and signature, requires the
   * entry to chain onto the current head. A duplicate entry ID is a no-op —
   * duplicates collapse on arrival rather than needing detection.
   */
  append(entry: LogEntry): { id: string; hash: string; duplicate: boolean } {
    validateEntry(entry);
    const id = entryId(entry);
    if (this.byId.has(id)) return { id, hash: entryHash(entry), duplicate: true };
    if (entry.prevEntryHash !== this.headHash) {
      throw new LogError(
        `entry does not chain onto head: prev=${entry.prevEntryHash ?? 'null'} head=${this.headHash ?? 'null'}`,
      );
    }
    const hash = entryHash(entry);
    this.entries.push(entry);
    this.hashes.push(hash);
    this.byId.add(id);
    return { id, hash, duplicate: false };
  }

  replay(): LedgerState {
    return replayState([...this.entries]);
  }
}

export interface Divergence {
  /** Entry hash both logs share, or null when the logs share nothing. */
  commonAncestor: string | null;
  /** Entry hashes on `local` after the ancestor, oldest first. */
  localSuffix: string[];
  /** Entry hashes on `remote` after the ancestor, oldest first. */
  remoteSuffix: string[];
}

/**
 * Fork detection: walk both chains back to the last shared entry hash and
 * report everything after it on each side. Identical heads → both suffixes
 * empty. Equal-length shared prefixes diverge at the first differing hash.
 */
export function findDivergence(local: TallyLog, remote: TallyLog): Divergence {
  const a = local.chainHashes();
  const b = remote.chainHashes();
  let shared = -1;
  const max = Math.min(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) shared = i;
    else break;
  }
  return {
    commonAncestor: shared >= 0 ? (a[shared] as string) : null,
    localSuffix: a.slice(shared + 1) as string[],
    remoteSuffix: b.slice(shared + 1) as string[],
  };
}

// --- obligation log root ----------------------------------------------------

const LEAF_PREFIX = new Uint8Array([0]);
const NODE_PREFIX = new Uint8Array([1]);

/**
 * Merkle root over the OBLIGATION_ACCEPT entry IDs consumed by a round
 * (PRD 3.3 `obligationLogRoot(r)`). Leaves are the 32-byte IDs sorted
 * lexicographically; leaf = Blake2b(0x00 || id), node = Blake2b(0x01 || l || r),
 * an odd node is promoted unchanged. Empty set → 32 zero bytes.
 */
export function obligationLogRoot(acceptEntryIds: string[]): Uint8Array {
  for (const id of acceptEntryIds) {
    if (!HASH_RE.test(id)) throw new LogError(`not a 32-byte entry ID: "${id}"`);
  }
  if (acceptEntryIds.length === 0) return new Uint8Array(32);
  let level = [...acceptEntryIds]
    .sort()
    .map((id) => Hash.computeBlake2b(concatBytes(LEAF_PREFIX, hexToBytes(id))));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(Hash.computeBlake2b(concatBytes(NODE_PREFIX, level[i] as Uint8Array, level[i + 1] as Uint8Array)));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1] as Uint8Array);
    level = next;
  }
  return level[0] as Uint8Array;
}
