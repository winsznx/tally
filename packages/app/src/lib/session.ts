/**
 * App-wide wallet session: where we are running, who is signed in, and what
 * they can spend. Wallet prompts only ever open from a person's tap, never from
 * a background effect.
 */
import { toAddressHex } from '@tally/core/settle';
import { NETWORK_ID } from './config.js';
import { loadIdentity, signIn, type Identity } from './identity.js';
import { Observable } from './observable.js';
import { readJson, writeJson } from './storage.js';
import { NimiqPayWallet, isInsideNimiqPay } from './wallet/nimiq-pay.js';
import { WalletError, type HostCapabilities, type WalletAccounts, type WalletPort } from './wallet/port.js';

export type SessionStatus = 'booting' | 'outside' | 'needs_sign_in' | 'connecting' | 'signing' | 'ready';

export interface Balance {
  luna: bigint | null;
  /** Why the balance is unknown, or a caveat about it. */
  note: string | null;
  readAt: number;
}

export interface SessionState {
  status: SessionStatus;
  caps: HostCapabilities | null;
  identity: Identity | null;
  accounts: WalletAccounts | null;
  balance: Balance | null;
  /** Nimiq Pay now lists a wallet that is not the signed-in identity. */
  accountMismatch: boolean;
  /** Nimiq Pay runs on a different network than this deployment. */
  networkMismatch: boolean;
  error: string | null;
  isPreview: boolean;
}

const LAST_IDENTITY = 'tally.v2.lastIdentity';
const expectedNetwork = NETWORK_ID === 24 ? 'mainnet' : 'testnet';

function walletErrorCopy(e: unknown): string {
  if (e instanceof WalletError) {
    if (e.kind === 'declined') return 'You cancelled in Nimiq Pay. You can sign in whenever you are ready.';
    if (e.kind === 'unsupported') return 'This version of Nimiq Pay cannot do that yet. Update Nimiq Pay and try again.';
    if (e.kind === 'unavailable') return e.message;
    return `Nimiq Pay could not complete the request: ${e.message}`;
  }
  return e instanceof Error ? e.message : 'Something went wrong talking to Nimiq Pay.';
}

export class SessionStore extends Observable<SessionState> {
  #wallet: WalletPort;
  #unsubscribe: (() => void) | null = null;

  constructor(wallet: WalletPort, isPreview: boolean) {
    super({
      status: 'booting',
      caps: null,
      identity: null,
      accounts: null,
      balance: null,
      accountMismatch: false,
      networkMismatch: false,
      error: null,
      isPreview,
    });
    this.#wallet = wallet;
  }

  get wallet(): WalletPort {
    return this.#wallet;
  }

  async boot(): Promise<void> {
    const caps = await this.#wallet.initialize();
    const usable = caps.inHost || caps.walletKind === 'preview';
    if (!usable) {
      this.patch({ status: 'outside', caps });
      return;
    }
    const networkMismatch = caps.network !== 'unknown' && caps.network !== expectedNetwork;
    const last = readJson<string>(LAST_IDENTITY);
    const identity = last ? loadIdentity(last) : null;
    this.patch({ caps, networkMismatch, identity, status: identity ? 'ready' : 'needs_sign_in' });
    this.#unsubscribe = this.#wallet.onAccountsChanged((accounts) => this.#onAccounts(accounts));
  }

  #onAccounts(accounts: WalletAccounts): void {
    const id = this.state.identity;
    let mismatch = false;
    try {
      mismatch = id !== null && toAddressHex(accounts.walletAddress) !== id.address;
    } catch {
      mismatch = false;
    }
    this.patch({ accounts, accountMismatch: mismatch });
    void this.refreshBalance();
  }

  /** Share accounts and bind this device (one or two wallet prompts). Call only from a tap. */
  async signIn(): Promise<Identity | null> {
    this.patch({ status: 'connecting', error: null });
    try {
      const accounts = await this.#wallet.requestAccounts();
      this.patch({ accounts, status: 'signing' });
      const identity = await signIn(this.#wallet, accounts.walletAddress);
      writeJson(LAST_IDENTITY, identity.address);
      this.patch({ identity, status: 'ready', accountMismatch: false });
      void this.refreshBalance();
      return identity;
    } catch (e) {
      this.patch({ status: this.state.identity ? 'ready' : 'needs_sign_in', error: walletErrorCopy(e) });
      return null;
    }
  }

  /** Reads the account list (prompting the first time) and the spendable HTLC balance. */
  async loadAccounts(): Promise<WalletAccounts | null> {
    if (this.state.accounts) return this.state.accounts;
    try {
      const accounts = await this.#wallet.requestAccounts();
      this.#onAccounts(accounts);
      return accounts;
    } catch (e) {
      this.patch({ error: walletErrorCopy(e) });
      return null;
    }
  }

  async refreshBalance(): Promise<void> {
    const accounts = this.state.accounts;
    if (!accounts) return;
    if (!accounts.htlcAddress) {
      this.patch({ balance: { luna: 0n, note: 'Your Nimiq Pay wallet has no spendable NIM yet. Top up in Nimiq Pay first.', readAt: Date.now() } });
      return;
    }
    const luna = await this.#wallet.getBalance(accounts.htlcAddress);
    this.patch({
      balance:
        luna === null
          ? { luna: null, note: 'This version of Nimiq Pay cannot report your balance. Nimiq Pay will still check it before paying.', readAt: Date.now() }
          : { luna, note: luna === 0n ? 'Reads zero. If Nimiq Pay is renewing your balance account this can be momentary.' : null, readAt: Date.now() },
    });
  }

  clearError(): void {
    this.patch({ error: null });
  }

  /** Forget this device's key for the signed-in account. Tabs stay on the server. */
  signOutDevice(): void {
    writeJson(LAST_IDENTITY, null);
    this.patch({ identity: null, status: 'needs_sign_in', accounts: null, balance: null });
  }

  dispose(): void {
    this.#unsubscribe?.();
  }
}

export async function createWallet(): Promise<{ wallet: WalletPort; isPreview: boolean }> {
  if (import.meta.env.DEV && !isInsideNimiqPay()) {
    const name = new URLSearchParams(window.location.search).get('preview');
    if (name) {
      const { PreviewWallet } = await import('./wallet/preview.js');
      return { wallet: new PreviewWallet(name), isPreview: true };
    }
  }
  return { wallet: new NimiqPayWallet(), isPreview: false };
}
