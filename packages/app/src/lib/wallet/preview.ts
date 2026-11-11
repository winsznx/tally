/**
 * A development-only stand-in wallet, so screens can be exercised in a desktop
 * browser. It holds a throwaway key derived from a name, signs messages exactly
 * the way Nimiq Pay does, and refuses to send money: there is no simulated
 * payment anywhere in Tally. It is only reachable from `import.meta.env.DEV`
 * builds and every screen labels it.
 */
import { Hash, KeyPair, PrivateKey } from '@nimiq/core';
import { nimiqSignedMessageDigest } from '@tally/core/binding';
import { WalletError, type HostCapabilities, type PaymentRequest, type SignedMessage, type WalletAccounts, type WalletPort } from './port.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class PreviewWallet implements WalletPort {
  readonly #key: KeyPair;

  constructor(readonly name: string) {
    const seed = Hash.computeSha256(new TextEncoder().encode(`tally-preview-wallet:${name}`));
    this.#key = KeyPair.derive(PrivateKey.fromHex(bytesToHex(seed)));
  }

  async initialize(): Promise<HostCapabilities> {
    return { inHost: false, network: 'mainnet', language: null, canReadBalance: false, walletKind: 'preview' };
  }

  async requestAccounts(): Promise<WalletAccounts> {
    return { walletAddress: this.#key.toAddress().toUserFriendlyAddress(), htlcAddress: null };
  }

  async signMessage(message: string): Promise<SignedMessage> {
    const signature = this.#key.sign(nimiqSignedMessageDigest(message));
    return { publicKey: bytesToHex(this.#key.publicKey.serialize()), signature: bytesToHex(signature.serialize()) };
  }

  async getBalance(): Promise<bigint | null> {
    return null;
  }

  async getBlockNumber(): Promise<number | null> {
    return null;
  }

  async sendNim(_request: PaymentRequest): Promise<{ txHash: string }> {
    throw new WalletError('unavailable', 'The preview wallet cannot send NIM. Open Tally in Nimiq Pay to pay.');
  }

  onAccountsChanged(): () => void {
    return () => undefined;
  }
}
