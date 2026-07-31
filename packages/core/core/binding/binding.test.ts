import { KeyPair, PrivateKey } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../internal/bytes.js';
import {
  bindingMessage,
  createBindingAttestation,
  nimiqSignedMessageDigest,
  verifyBindingAttestation,
  type BindingAttestation,
} from './index.js';

const account = KeyPair.derive(PrivateKey.fromHex('a1'.repeat(32)));
const purse = KeyPair.derive(PrivateKey.fromHex('b2'.repeat(32)));
const attacker = KeyPair.derive(PrivateKey.fromHex('ee'.repeat(32)));

const purseHex = bytesToHex(purse.publicKey.serialize());
const accountAddrHex = bytesToHex(account.toAddress().serialize());

describe('Nimiq Signed Message scheme', () => {
  it('matches the pinned digest for a fixed message (guards against a scheme change)', () => {
    // sha256("\x16Nimiq Signed Message:\n" + "5" + "hello"), per core-rs-albatross.
    expect(bytesToHex(nimiqSignedMessageDigest('hello'))).toBe(
      'fd72a0cd679fd00d472df44647303eadebe81903fe59d5b20e12961b7ea654a1',
    );
  });

  it('builds the PRD 3.1 message with a user-friendly account and hex purse', () => {
    const msg = bindingMessage(accountAddrHex, purseHex);
    expect(msg.startsWith('Tally purse binding v1\naccount: NQ')).toBe(true);
    expect(msg.endsWith(`\npurse: ${purseHex}`)).toBe(true);
  });
});

describe('binding attestation', () => {
  it('accepts a valid binding', () => {
    const att = createBindingAttestation(account, purseHex);
    expect(verifyBindingAttestation(att)).toBe(true);
  });

  it('rejects a binding whose account public key derives a different address (wrong account)', () => {
    const att = createBindingAttestation(account, purseHex);
    const wrongAccount: BindingAttestation = {
      ...att,
      accountAddress: bytesToHex(attacker.toAddress().serialize()),
    };
    expect(verifyBindingAttestation(wrongAccount)).toBe(false);
  });

  it('rejects a binding signed by a key other than the claimed account', () => {
    const att = createBindingAttestation(account, purseHex);
    const forged: BindingAttestation = {
      ...att,
      accountPublicKey: bytesToHex(attacker.publicKey.serialize()),
      accountAddress: bytesToHex(attacker.toAddress().serialize()),
    };
    // signature was made by `account`, but now claims `attacker` signed it
    expect(verifyBindingAttestation(forged)).toBe(false);
  });

  it('rejects a binding replayed onto a different purse (attestation names the wrong purse)', () => {
    // A real, valid binding for `purse`. An attacker reuses it while claiming a
    // different purse key — verification reconstructs the message from the
    // claimed purse, so the signature no longer matches.
    const real = createBindingAttestation(account, purseHex);
    const attackerPurseHex = bytesToHex(attacker.publicKey.serialize());
    const replayed: BindingAttestation = { ...real, pursePublicKey: attackerPurseHex };
    expect(verifyBindingAttestation(replayed)).toBe(false);
  });

  it('rejects a tampered signature and structurally malformed input without throwing', () => {
    const att = createBindingAttestation(account, purseHex);
    expect(verifyBindingAttestation({ ...att, bindingSignature: att.bindingSignature.replace(/.$/, '0') })).toBe(false);
    expect(verifyBindingAttestation({ ...att, accountPublicKey: 'zz' })).toBe(false);
    expect(verifyBindingAttestation({ ...att, accountAddress: '00' })).toBe(false);
    expect(verifyBindingAttestation({} as BindingAttestation)).toBe(false);
  });
});
