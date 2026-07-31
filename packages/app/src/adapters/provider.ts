/**
 * Nimiq Pay provider adapter — wraps @nimiq/mini-app-sdk.
 *
 * Two behaviours the docs get wrong, both confirmed on-device by the harness:
 *  - `sendBasicTransaction[WithData]` returns the FULL serialized signed
 *    transaction, not a hash. We deserialize it to recover the Pay address,
 *    hash, fee, validityStartHeight and networkId — which is what lets setup be
 *    two dialogs instead of three (no `listAccounts`).
 *  - Declining a dialog is a normal outcome. It resolves to `declined`, never
 *    an error path.
 */
import { Transaction } from '@nimiq/core';
import { init as connectWallet, getHostLanguage } from '@nimiq/mini-app-sdk';
import type { ErrorResponse, NimiqProvider } from '@nimiq/mini-app-sdk';
import {
  DECLINED,
  ok,
  providerError,
  type BasicTxParams,
  type BasicTxWithDataParams,
  type ProviderAdapter,
  type ProviderResult,
  type SignatureResult,
  type WalletTx,
} from './types.js';

const LUNA = (nim: bigint): number => Number(nim);

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function isErrorResponse(x: unknown): x is ErrorResponse {
  return typeof x === 'object' && x !== null && 'error' in x;
}

/**
 * Synchronous inside-Nimiq-Pay check for the origin split and the read-only
 * preview — `window.nimiqPay` is seeded before the page script runs, so this is
 * reliable and never blocks first paint on `init()`'s connect timeout.
 */
export function isInsideNimiqPaySync(): boolean {
  return typeof window !== 'undefined' && typeof window.nimiqPay !== 'undefined';
}

/**
 * The SDK/wallet surfaces a declined dialog as an error object or a thrown
 * error. We classify: user rejection → `declined`; anything else → `error`.
 */
function looksDeclined(message: string): boolean {
  return /declin|reject|denied|cancel|user (closed|dismissed)/i.test(message);
}

export class NimiqPayProvider implements ProviderAdapter {
  #provider: NimiqProvider | undefined;
  #inside = false;
  #language: string | undefined;
  #detectedNetworkId: number | undefined;

  constructor(private readonly timeoutMs = 8000) {}

  get insideNimiqPay(): boolean {
    return this.#inside;
  }
  get language(): string | undefined {
    return this.#language;
  }
  get detectedNetworkId(): number | undefined {
    return this.#detectedNetworkId;
  }

  async init(): Promise<{ insideNimiqPay: boolean; language: string | undefined }> {
    this.#language = getHostLanguage();
    try {
      this.#provider = await connectWallet({ timeout: this.timeoutMs });
      this.#inside = true;
    } catch {
      this.#inside = false;
    }
    return { insideNimiqPay: this.#inside, language: this.#language };
  }

  #require(): NimiqProvider {
    if (!this.#provider) throw new Error('not running inside Nimiq Pay');
    return this.#provider;
  }

  async sign(message: string): Promise<ProviderResult<SignatureResult>> {
    try {
      const res = await this.#require().sign(message);
      if (isErrorResponse(res)) {
        const m = JSON.stringify(res.error);
        return looksDeclined(m) ? DECLINED : providerError(m);
      }
      return ok({ publicKey: res.publicKey, signature: res.signature });
    } catch (e) {
      return this.#fromThrow(e);
    }
  }

  async sendBasicTransaction(p: BasicTxParams): Promise<ProviderResult<WalletTx>> {
    return this.#send(() =>
      this.#require().sendBasicTransaction({
        recipient: p.recipient,
        value: LUNA(p.value),
        ...(p.fee !== undefined ? { fee: LUNA(p.fee) } : {}),
        ...(p.validityStartHeight !== undefined ? { validityStartHeight: p.validityStartHeight } : {}),
      }),
    );
  }

  async sendBasicTransactionWithData(p: BasicTxWithDataParams): Promise<ProviderResult<WalletTx>> {
    return this.#send(() =>
      this.#require().sendBasicTransactionWithData({
        recipient: p.recipient,
        value: LUNA(p.value),
        data: p.data,
        ...(p.fee !== undefined ? { fee: LUNA(p.fee) } : {}),
        ...(p.validityStartHeight !== undefined ? { validityStartHeight: p.validityStartHeight } : {}),
      }),
    );
  }

  async #send(call: () => Promise<string | ErrorResponse>): Promise<ProviderResult<WalletTx>> {
    try {
      const res = await call();
      if (isErrorResponse(res)) {
        const m = JSON.stringify(res.error);
        return looksDeclined(m) ? DECLINED : providerError(m);
      }
      return ok(this.#deserialize(res));
    } catch (e) {
      return this.#fromThrow(e);
    }
  }

  /** Recover the wallet tx from the serialized string it returns. */
  #deserialize(serializedHex: string): WalletTx {
    const tx = Transaction.fromAny(serializedHex);
    this.#detectedNetworkId = tx.networkId;
    return {
      serializedHex,
      hash: tx.hash(),
      sender: tx.sender.toUserFriendlyAddress(),
      recipient: tx.recipient.toUserFriendlyAddress(),
      value: tx.value,
      fee: tx.fee,
      validityStartHeight: tx.validityStartHeight,
      networkId: tx.networkId,
      dataHex: bytesToHex(tx.data),
    };
  }

  #fromThrow(e: unknown): ProviderResult<never> {
    const m = this.#messageOf(e);
    return looksDeclined(m) ? DECLINED : providerError(m);
  }

  /** A thrown decline can be an ErrorResponse or a bare {message} object, not
   * only an Error — mirror the resolve path so it still classifies as declined. */
  #messageOf(e: unknown): string {
    if (isErrorResponse(e)) return JSON.stringify(e.error);
    if (e instanceof Error) return e.message;
    if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
    return String(e);
  }
}
