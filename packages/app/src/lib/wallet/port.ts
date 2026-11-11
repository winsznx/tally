/**
 * The app's view of a wallet. These are application names, not SDK method
 * names; the Nimiq Pay implementation maps them onto documented SDK calls only.
 *
 * Two addresses matter and they are never the same thing:
 *   identity    the wallet address whose key signs (proven by a signature)
 *   spendable   the current HTLC Nimiq Pay pays from; rotates roughly weekly
 */
export type HostNetwork = 'mainnet' | 'testnet' | 'unknown';

export interface HostCapabilities {
  inHost: boolean;
  network: HostNetwork;
  language: string | null;
  canReadBalance: boolean;
  walletKind: 'nimiq-pay' | 'preview' | 'none';
}

export interface WalletAccounts {
  /** User-friendly wallet address, as the host lists it. Not proof of anything. */
  walletAddress: string;
  /** User-friendly address of the current HTLC holding spendable NIM, if funded. */
  htlcAddress: string | null;
}

export interface SignedMessage {
  publicKey: string;
  signature: string;
}

export interface PaymentRequest {
  /** User-friendly recipient address. */
  recipient: string;
  luna: bigint;
  /** Public UTF-8 memo, at most 64 bytes. */
  memo: string;
}

export type WalletErrorKind =
  /** The person said no. Nothing happened. */
  | 'declined'
  /** The host refused before showing a prompt (bad parameters). Nothing was sent. */
  | 'rejected_before_prompt'
  /** This host does not support the request. */
  | 'unsupported'
  /** A send may or may not have gone out. Reconcile before anything else. */
  | 'outcome_unknown'
  /** Not running inside Nimiq Pay, or the provider never appeared. */
  | 'unavailable'
  | 'internal';

export class WalletError extends Error {
  constructor(
    readonly kind: WalletErrorKind,
    message: string,
    readonly hostType: string | null = null,
    readonly data: unknown = undefined,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface WalletPort {
  initialize(): Promise<HostCapabilities>;
  /** Opens the host's account-sharing prompt the first time. */
  requestAccounts(): Promise<WalletAccounts>;
  signMessage(message: string): Promise<SignedMessage>;
  /** Luna, or null when the host cannot read balances. A zero during HTLC rotation is not proof of no funds. */
  getBalance(address: string): Promise<bigint | null>;
  getBlockNumber(): Promise<number | null>;
  /** Resolves with the transaction hash. A hash is not proof of payment. */
  sendNim(request: PaymentRequest): Promise<{ txHash: string }>;
  onAccountsChanged(handler: (accounts: WalletAccounts) => void): () => void;
}
