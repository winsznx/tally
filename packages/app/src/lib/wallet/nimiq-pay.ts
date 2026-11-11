import { Transaction } from '@nimiq/core';
import { NimiqProviderError, getHostLanguage, getHostNetwork, init } from '@nimiq/mini-app-sdk';
import { lunaToSafeNumber } from '../money.js';
import {
  WalletError,
  type HostCapabilities,
  type PaymentRequest,
  type SignedMessage,
  type WalletAccounts,
  type WalletPort,
} from './port.js';

type Provider = Awaited<ReturnType<typeof init>>;

const HASH_RE = /^[0-9a-f]{64}$/;

/** `window.nimiqPay` is seeded before page scripts run, so this answers without waiting. */
export function isInsideNimiqPay(): boolean {
  return typeof window !== 'undefined' && typeof window.nimiqPay !== 'undefined';
}

function toAccounts(list: readonly string[]): WalletAccounts {
  const [walletAddress, htlcAddress] = list;
  if (!walletAddress) throw new WalletError('internal', 'Nimiq Pay shared no account.');
  return { walletAddress, htlcAddress: htlcAddress ?? null };
}

/**
 * Maps a provider failure to what the person can do next. For sends, anything
 * other than a clear decline or a pre-prompt rejection is treated as an unknown
 * outcome: the docs say to check payment status before resending, and guessing
 * "failed" here is exactly how people pay twice.
 */
export function classifyProviderError(error: unknown, duringSend: boolean): WalletError {
  if (error instanceof WalletError) return error;
  const providerError = NimiqProviderError.from(error);
  const type = providerError?.type ?? null;
  const message = providerError?.message ?? (error instanceof Error ? error.message : 'The wallet did not answer.');
  if (type === 'PERMISSION_DENIED' || /\b(cancel|declin|reject|denied)/i.test(type === null ? message : '')) {
    return new WalletError('declined', 'You cancelled in Nimiq Pay.', type);
  }
  if (type === 'UNKNOWN_REQUEST') return new WalletError('unsupported', 'This version of Nimiq Pay does not support that request.', type);
  if (type === 'INVALID_TRANSACTION') {
    return new WalletError('rejected_before_prompt', `Nimiq Pay refused the payment details: ${message}`, type);
  }
  if (duringSend) return new WalletError('outcome_unknown', message, type, providerError?.data);
  return new WalletError('internal', message, type, providerError?.data);
}

/**
 * The SDK typings say the send methods return the serialized transaction, the
 * docs say the hash, and Phase 0 saw the serialized form on a device. Accept
 * both, and when it is the full transaction, check it says what we asked.
 */
export function hashFromSendResult(result: unknown, request: PaymentRequest): string {
  if (typeof result !== 'string' || result.length === 0) {
    throw new WalletError('outcome_unknown', 'Nimiq Pay returned no transaction reference.');
  }
  const hex = result.toLowerCase().replace(/^0x/, '');
  if (HASH_RE.test(hex)) return hex;
  let tx: Transaction;
  try {
    tx = Transaction.fromAny(hex);
  } catch {
    throw new WalletError('outcome_unknown', 'Nimiq Pay returned a transaction reference this app cannot read.');
  }
  if (tx.recipient.toUserFriendlyAddress().replace(/\s/g, '') !== request.recipient.replace(/\s/g, '') || tx.value !== request.luna) {
    throw new WalletError('outcome_unknown', 'The signed transaction does not match the payment you approved.');
  }
  return tx.hash().toLowerCase();
}

export class NimiqPayWallet implements WalletPort {
  #provider: Provider | null = null;
  #initialized: Promise<HostCapabilities> | null = null;

  constructor(private readonly timeoutMs = 8000) {}

  initialize(): Promise<HostCapabilities> {
    this.#initialized ??= this.#doInitialize();
    return this.#initialized;
  }

  async #doInitialize(): Promise<HostCapabilities> {
    const language = getHostLanguage() ?? null;
    const hostNetwork = getHostNetwork();
    try {
      this.#provider = await init({ timeout: this.timeoutMs });
    } catch {
      return { inHost: false, network: 'unknown', language, canReadBalance: false, walletKind: 'none' };
    }
    return {
      inHost: true,
      network: hostNetwork === 'mainnet' || hostNetwork === 'testnet' ? hostNetwork : 'unknown',
      language,
      canReadBalance: typeof this.#provider.getBalance === 'function',
      walletKind: 'nimiq-pay',
    };
  }

  #require(): Provider {
    if (!this.#provider) throw new WalletError('unavailable', 'Open Tally inside Nimiq Pay to use your wallet.');
    return this.#provider;
  }

  async requestAccounts(): Promise<WalletAccounts> {
    try {
      return toAccounts(await this.#require().listAccounts());
    } catch (e) {
      throw classifyProviderError(e, false);
    }
  }

  async signMessage(message: string): Promise<SignedMessage> {
    try {
      const res = await this.#require().sign(message);
      return { publicKey: res.publicKey.toLowerCase(), signature: res.signature.toLowerCase() };
    } catch (e) {
      throw classifyProviderError(e, false);
    }
  }

  async getBalance(address: string): Promise<bigint | null> {
    const provider = this.#require();
    if (typeof provider.getBalance !== 'function') return null;
    try {
      return BigInt(await provider.getBalance(address));
    } catch {
      return null;
    }
  }

  async getBlockNumber(): Promise<number | null> {
    try {
      return await this.#require().getBlockNumber();
    } catch {
      return null;
    }
  }

  async sendNim(request: PaymentRequest): Promise<{ txHash: string }> {
    const provider = this.#require();
    const value = lunaToSafeNumber(request.luna);
    if (new TextEncoder().encode(request.memo).length > 64) {
      throw new WalletError('rejected_before_prompt', 'The payment memo is longer than 64 bytes.');
    }
    let result: unknown;
    try {
      result = await provider.sendBasicTransactionWithData({ recipient: request.recipient, value, data: request.memo });
    } catch (e) {
      throw classifyProviderError(e, true);
    }
    return { txHash: hashFromSendResult(result, request) };
  }

  onAccountsChanged(handler: (accounts: WalletAccounts) => void): () => void {
    const provider = this.#provider;
    if (!provider) return () => undefined;
    const listener = (accounts: unknown): void => {
      if (Array.isArray(accounts) && accounts.every((a) => typeof a === 'string')) {
        try {
          handler(toAccounts(accounts as string[]));
        } catch (e) {
          console.warn('[tally] ignored malformed accountsChanged payload', e);
        }
      }
    };
    provider.on('accountsChanged', listener);
    return () => {
      provider.removeListener('accountsChanged', listener);
    };
  }
}
