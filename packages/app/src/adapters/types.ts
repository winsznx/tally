/**
 * Adapter contracts. Everything external to the app — the Nimiq Pay provider,
 * the chain, the relay, and even the clock — sits behind one of these
 * interfaces so the whole app is testable with no phone and no network. Amounts
 * are Luna as bigint; a float touching an amount is a bug.
 */

/** TestAlbatross = 5, MainAlbatross = 24. The only two we support. */
export type NetworkId = 5 | 24;
export const TESTNET: NetworkId = 5;
export const MAINNET: NetworkId = 24;

export function networkName(id: NetworkId): 'testnet' | 'mainnet' {
  return id === MAINNET ? 'mainnet' : 'testnet';
}

/**
 * Result of a wallet operation. Declining a dialog is a NORMAL outcome, never an
 * error path — it resolves to `declined`, which the UI handles as a state.
 * `error` is for genuine failures (not inside Nimiq Pay, network wrong, etc.).
 */
export type ProviderResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly message: string };

export function ok<T>(value: T): ProviderResult<T> {
  return { kind: 'ok', value };
}
export const DECLINED: ProviderResult<never> = { kind: 'declined' };
export function providerError(message: string): ProviderResult<never> {
  return { kind: 'error', message };
}

export interface SignatureResult {
  /** 64 hex — the account public key that produced the signature. */
  readonly publicKey: string;
  /** 128 hex Ed25519 signature. */
  readonly signature: string;
}

/**
 * A wallet-signed transaction, recovered by deserializing the FULL serialized
 * transaction the SDK returns (the docs say "hash" — they are wrong; the harness
 * confirmed the serialized tx, which is what removes the listAccounts dialog).
 */
export interface WalletTx {
  readonly serializedHex: string;
  readonly hash: string;
  /** The user's Nimiq Pay account address (user-friendly), recovered from the tx. */
  readonly sender: string;
  readonly recipient: string;
  readonly value: bigint;
  readonly fee: bigint;
  readonly validityStartHeight: number;
  readonly networkId: number;
  readonly dataHex: string;
}

export interface BasicTxParams {
  readonly recipient: string;
  readonly value: bigint;
  readonly fee?: bigint;
  readonly validityStartHeight?: number;
}
export interface BasicTxWithDataParams extends BasicTxParams {
  readonly data: string;
}

/** Wraps @nimiq/mini-app-sdk. Never throws on a declined dialog. */
export interface ProviderAdapter {
  /** Resolves once, to whether we are running inside Nimiq Pay. */
  init(): Promise<{ insideNimiqPay: boolean; language: string | undefined }>;
  readonly insideNimiqPay: boolean;
  readonly language: string | undefined;
  /** The wallet's network id, known only AFTER the first returned tx. */
  readonly detectedNetworkId: number | undefined;
  sign(message: string): Promise<ProviderResult<SignatureResult>>;
  sendBasicTransaction(params: BasicTxParams): Promise<ProviderResult<WalletTx>>;
  sendBasicTransactionWithData(params: BasicTxWithDataParams): Promise<ProviderResult<WalletTx>>;
}

/** A transaction as seen on-chain, from RPC or the light client. */
export interface ChainTx {
  readonly hash: string;
  readonly sender: string;
  readonly recipient: string;
  readonly value: bigint;
  readonly validityStartHeight: number;
  readonly blockHeight: number | undefined;
  /** True only at macro-block finality. Nothing is "settled" before this. */
  readonly confirmed: boolean;
  readonly dataHex: string | undefined;
}

export type ConsensusState = 'connecting' | 'syncing' | 'established' | 'lost';

/**
 * Reads and broadcasts against the chain. RPC-first (all six methods are
 * permitted — enumerated in Phase 0); the light client is a lazy verification
 * layer. Both implementations satisfy this one interface.
 */
export interface ChainAdapter {
  headHeight(): Promise<number>;
  networkId(): Promise<NetworkId>;
  getBalance(address: string): Promise<bigint>;
  /** getTransactionsByAddress(address, max, startAt) — three positional RPC params. */
  getTransactionsByAddress(address: string, max?: number, startAt?: string | null): Promise<ChainTx[]>;
  getTransactionByHash(hash: string): Promise<ChainTx | null>;
  /** Broadcast a fully serialized signed transaction. */
  broadcast(serializedHex: string): Promise<{ hash: string }>;
  /**
   * Live updates for the given addresses. Returns an unsubscribe function. An
   * adapter that cannot stream (bare RPC) returns a no-op unsubscribe and the
   * app falls back to its heartbeat poll — visibly, never to silence.
   */
  subscribe?(addresses: string[], onTx: (tx: ChainTx) => void): Promise<() => void>;
  /**
   * Observe consensus state so the app can show the "connection lost" banner and
   * freeze settlement (obligations still record locally). Adapters that cannot
   * observe consensus (bare RPC) omit this; the app treats its absence as
   * "assume established" and relies on request failures instead.
   */
  onConsensusChanged?(cb: (state: ConsensusState) => void): Promise<() => void>;
}

/** One signed log entry as carried by the relay (opaque payload/signature). */
export interface RelayEntry {
  readonly entryId: string;
  readonly prevEntryHash: string | null;
  readonly authorAddress: string;
  /** The full LogEntry, JSON-encoded exactly as signed. */
  readonly entryJson: string;
  readonly receivedAt: number;
}

/**
 * The log transport. UNTRUSTED and possibly down. Every response is re-verified
 * locally; when unreachable the app runs read-only from cached log state rather
 * than showing an error page.
 */
export interface RelayAdapter {
  createLedger(network: NetworkId): Promise<{ ledgerId: string; network: NetworkId }>;
  getHead(ledgerId: string): Promise<string | null>;
  getSince(ledgerId: string, sinceHash: string | null): Promise<RelayEntry[]>;
  append(ledgerId: string, entriesJson: string[]): Promise<void>;
  /** Distinct account count across all ledgers (GAP 6). */
  stats(): Promise<number>;
}

/** Injectable clock so countdowns are testable without waiting. */
export interface ClockAdapter {
  /** Milliseconds since epoch. */
  now(): number;
}
