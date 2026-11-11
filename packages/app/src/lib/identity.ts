/**
 * Who you are in Tally.
 *
 * A member has two keys. The wallet key lives in Nimiq Pay and is only ever
 * asked for signatures. The device key is generated here and signs your tab
 * entries (requests, acceptances, payment claims); it holds no funds and can
 * move none. One wallet signature binds the two, and that binding is public in
 * every tab you join, so anyone can check the device key speaks for you.
 *
 * Identity is the address derived from the signature's public key, never the
 * first entry of `listAccounts()`: the wallet chooses the signer, and the
 * account list proves nothing on its own.
 */
import { KeyPair, PrivateKey, PublicKey } from '@nimiq/core';
import { bindingMessageV2, verifyBindingAttestation, type BindingAttestation } from '@tally/core/binding';
import { toAddressHex, toUserFriendly } from '@tally/core/settle';
import { readJson, writeJson } from './storage.js';
import { WalletError, type WalletPort } from './wallet/port.js';

export interface Identity {
  /** 40-hex account address, proven by the binding signature. */
  address: string;
  session: KeyPair;
  attestation: BindingAttestation;
}

interface StoredIdentity {
  address: string;
  sessionPrivateKey: string;
  attestation: BindingAttestation;
}

const key = (addressHex: string): string => `tally.v2.identity.${addressHex}`;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function addressOfPublicKey(publicKeyHex: string): string {
  return bytesToHex(PublicKey.deserialize(hexToBytes(publicKeyHex)).toAddress().serialize());
}

export function loadIdentity(addressHex: string): Identity | null {
  const stored = readJson<StoredIdentity>(key(addressHex));
  if (!stored || stored.address !== addressHex) return null;
  const session = KeyPair.derive(PrivateKey.fromHex(stored.sessionPrivateKey));
  if (bytesToHex(session.publicKey.serialize()) !== stored.attestation.pursePublicKey) return null;
  if (!verifyBindingAttestation(stored.attestation)) return null;
  return { address: stored.address, session, attestation: stored.attestation };
}

function saveIdentity(identity: Identity): void {
  writeJson<StoredIdentity>(key(identity.address), {
    address: identity.address,
    sessionPrivateKey: identity.session.privateKey.toHex(),
    attestation: identity.attestation,
  });
}

async function bindOnce(wallet: WalletPort, claimedAddressHex: string, session: KeyPair): Promise<BindingAttestation> {
  const sessionPk = bytesToHex(session.publicKey.serialize());
  const signed = await wallet.signMessage(bindingMessageV2(claimedAddressHex, sessionPk));
  return {
    accountAddress: addressOfPublicKey(signed.publicKey),
    accountPublicKey: signed.publicKey,
    pursePublicKey: sessionPk,
    bindingSignature: signed.signature,
  };
}

/**
 * Bind a fresh device key to the wallet. One signature in the normal case. If
 * the wallet signed with a different account than it listed first, the
 * signature names the wrong address and cannot verify, so we ask once more,
 * naming the account that actually signed.
 */
export async function signIn(wallet: WalletPort, listedWalletAddress: string): Promise<Identity> {
  const listedHex = toAddressHex(listedWalletAddress);
  const existing = loadIdentity(listedHex);
  if (existing) return existing;

  const session = KeyPair.generate();
  let attestation = await bindOnce(wallet, listedHex, session);
  if (!verifyBindingAttestation(attestation)) {
    const signer = attestation.accountAddress;
    const already = loadIdentity(signer);
    if (already) return already;
    attestation = await bindOnce(wallet, signer, session);
    if (!verifyBindingAttestation(attestation)) {
      throw new WalletError('internal', 'Nimiq Pay returned a signature that does not verify, so Tally cannot sign you in.');
    }
  }
  const identity: Identity = { address: attestation.accountAddress, session, attestation };
  saveIdentity(identity);
  return identity;
}

export function shortAddress(addressHex: string): string {
  const friendly = toUserFriendly(addressHex);
  const parts = friendly.split(' ');
  return `${parts[0]} … ${parts[parts.length - 1]}`;
}

export function friendlyAddress(addressHex: string): string {
  return toUserFriendly(addressHex);
}
