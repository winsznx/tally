import { KeyPair, PrivateKey, Transaction, Address } from '@nimiq/core';
import { NimiqProviderError } from '@nimiq/mini-app-sdk';
import { describe, expect, it } from 'vitest';
import { classifyProviderError, hashFromSendResult } from './nimiq-pay.js';

describe('classifyProviderError', () => {
  it('maps a cancel to declined, whether sending or not', () => {
    const e = new NimiqProviderError('PERMISSION_DENIED', 'User rejected', 4001);
    expect(classifyProviderError(e, true).kind).toBe('declined');
    expect(classifyProviderError(e, false).kind).toBe('declined');
  });
  it('maps a bare legacy code 4001 to declined', () => {
    expect(classifyProviderError({ code: 4001, message: 'denied' }, true).kind).toBe('declined');
  });
  it('maps pre-prompt rejections and unsupported requests safely', () => {
    expect(classifyProviderError(new NimiqProviderError('INVALID_TRANSACTION', 'data too long', -32602), true).kind).toBe(
      'rejected_before_prompt',
    );
    expect(classifyProviderError(new NimiqProviderError('UNKNOWN_REQUEST', 'nope', 4200), true).kind).toBe('unsupported');
  });
  it('treats every other failure during a send as an unknown outcome, never as failed', () => {
    for (const type of ['NETWORK_ERROR', 'INTERNAL_ERROR', 'TRANSACTION_OUTCOME_UNKNOWN', 'DUPLICATE_PAYMENT', 'SOMETHING_NEW']) {
      expect(classifyProviderError(new NimiqProviderError(type, 'x'), true).kind).toBe('outcome_unknown');
    }
    expect(classifyProviderError(new Error('socket closed'), true).kind).toBe('outcome_unknown');
  });
});

describe('hashFromSendResult', () => {
  const recipient = Address.fromString('a'.repeat(40)).toUserFriendlyAddress();

  it('accepts a bare transaction hash', () => {
    expect(hashFromSendResult('AB'.repeat(32), { recipient, luna: 5n, memo: 'm' })).toBe('ab'.repeat(32));
  });

  it('recovers the hash from a full serialized transaction and checks it matches', () => {
    const key = KeyPair.derive(PrivateKey.fromHex('11'.repeat(32)));
    const tx = new Transaction(key.toAddress(), 0, undefined, Address.fromString('a'.repeat(40)), 0, undefined, 5n, 0n, 0, 1000, 24);
    tx.sign(key, undefined);
    const serialized = tx.toHex();
    expect(hashFromSendResult(serialized, { recipient, luna: 5n, memo: 'm' })).toBe(tx.hash().toLowerCase());
    expect(() => hashFromSendResult(serialized, { recipient, luna: 6n, memo: 'm' })).toThrow(/does not match/);
  });

  it('treats an empty result as an unknown outcome', () => {
    expect(() => hashFromSendResult('', { recipient, luna: 5n, memo: 'm' })).toThrow(/no transaction reference/);
  });
});
