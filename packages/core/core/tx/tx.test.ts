import { KeyPair, PrivateKey } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8 } from '../internal/bytes.js';
import { decodeAnchor } from '../anchor/index.js';
import { computePlan } from '../netting/index.js';
import {
  MAINNET_NETWORK_ID,
  TESTNET_NETWORK_ID,
  TxBuildError,
  buildSettlementLeg,
  derivePurse,
  type BuildLegParams,
} from './index.js';

const purse = KeyPair.derive(PrivateKey.fromHex('11'.repeat(32)));
const other = KeyPair.derive(PrivateKey.fromHex('22'.repeat(32)));
const purseAddr = bytesToHex(purse.toAddress().serialize());
const otherAddr = bytesToHex(other.toAddress().serialize());

function fixedParams(): BuildLegParams {
  const plan = computePlan(
    [purseAddr, otherAddr],
    [{ debtor: purseAddr, creditor: otherAddr, amount: 12345n }],
  );
  return {
    purse,
    plan,
    index: 1,
    genesisHash: 'ab'.repeat(32),
    roundRoot: hexToBytes('cd'.repeat(20)),
    roundContext: { round: 7, anchorHeight: 3_000_000 },
    networkId: TESTNET_NETWORK_ID,
  };
}

describe('Test 2b Part A — byte-for-byte determinism (permanent)', () => {
  it('building the same leg twice from fixed inputs yields identical hash and bytes', () => {
    const a = buildSettlementLeg(fixedParams());
    const b = buildSettlementLeg(fixedParams());
    expect(a.hash).toBe(b.hash);
    expect(a.serializedHex).toBe(b.serializedHex);
    expect(bytesToHex(a.tx.serialize())).toBe(bytesToHex(b.tx.serialize()));
  });

  it('matches the pinned fixture — a change here means the wire bytes changed', () => {
    const leg = buildSettlementLeg(fixedParams());
    expect(leg.anchor).toBe('TLY1.VOV2XK5L.AAAH.1/1.zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0');
    expect(leg.hash).toBe('92b82645d5ab0dd088b930efe9ebf1017c75fe10677a7daec34f484db6c5c041');
    expect(leg.serializedHex).toBe(
      '01d3bd75fcd7676504671ee75f95e1ed7ada6d168d0000fc8c895fc144884e989a32a7cbfbf47346ad39260032544c59312e564f5632584b354c2e414141482e312f312e7a63334e7a63334e7a63334e7a63334e7a63334e7a63334e7a633000000000000030390000000000000000002dc6c005006200d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737004f25b3bda9c694f24ae90f28cdc673582063d6ed0eabe0fce6c5484e4bcfb0df2946429bafbff913974e595a7168032fea791a10ebf7e11dbb0b3f0b6c0a8507',
    );
  });

  it('every field is derived: fee 0, value from plan, data is the anchor, vsh from the round context', () => {
    const leg = buildSettlementLeg(fixedParams());
    expect(leg.tx.fee).toBe(0n);
    expect(leg.tx.value).toBe(12345n);
    expect(leg.tx.validityStartHeight).toBe(3_000_000);
    expect(bytesToHex(leg.tx.data)).toBe(bytesToHex(utf8(leg.anchor)));
    const fields = decodeAnchor(new TextDecoder().decode(leg.tx.data));
    expect(fields.round).toBe(7);
    expect(fields.index).toBe(1);
    expect(fields.count).toBe(1);
    expect(bytesToHex(fields.root)).toBe('cd'.repeat(20));
    expect(bytesToHex(fields.ledgerTag)).toBe('ab'.repeat(5));
  });

  it('a different anchorHeight produces different bytes — vsh is part of identity', () => {
    const base = buildSettlementLeg(fixedParams());
    const shifted = buildSettlementLeg({
      ...fixedParams(),
      roundContext: { round: 7, anchorHeight: 3_000_003 },
    });
    expect(shifted.hash).not.toBe(base.hash);
    expect(shifted.serializedHex).not.toBe(base.serializedHex);
  });
});

describe('leg construction guards', () => {
  it('refuses to sign a leg the purse does not own', () => {
    const params = fixedParams();
    expect(() => buildSettlementLeg({ ...params, purse: other })).toThrow(TxBuildError);
  });

  it('rejects out-of-range indices', () => {
    const params = fixedParams();
    expect(() => buildSettlementLeg({ ...params, index: 0 })).toThrow(TxBuildError);
    expect(() => buildSettlementLeg({ ...params, index: 2 })).toThrow(TxBuildError);
  });

  it('rejects unknown network IDs and non-positive anchor heights', () => {
    const params = fixedParams();
    expect(() => buildSettlementLeg({ ...params, networkId: 42 })).toThrow(TxBuildError);
    expect(() => buildSettlementLeg({ ...params, roundContext: { round: 7, anchorHeight: 0 } })).toThrow(TxBuildError);
    expect(MAINNET_NETWORK_ID).toBe(24);
  });

  it('rejects an anchor height above the u32 ceiling that @nimiq/core would wrap to 0', () => {
    const params = fixedParams();
    expect(() => buildSettlementLeg({ ...params, roundContext: { round: 7, anchorHeight: 0x1_0000_0000 } })).toThrow(TxBuildError);
    expect(() => buildSettlementLeg({ ...params, roundContext: { round: 7, anchorHeight: 0xffffffff } })).not.toThrow();
  });
});

describe('purse derivation — PRD 3.1', () => {
  const bindingSignature = hexToBytes('42'.repeat(64));

  it('is a pure function of the binding signature (pinned fixture)', () => {
    const a = derivePurse(bindingSignature);
    const b = derivePurse(bindingSignature);
    expect(bytesToHex(a.toAddress().serialize())).toBe('3a56ceac5305a0f9a4938f15817e5b3d233fe5ab');
    expect(a.toAddress().equals(b.toAddress())).toBe(true);
    expect(bytesToHex(a.privateKey.serialize())).toBe(bytesToHex(b.privateKey.serialize()));
  });

  it('different signatures and different domain separators yield different purses', () => {
    const base = derivePurse(bindingSignature);
    const otherSig = derivePurse(hexToBytes('43'.repeat(64)));
    const otherDomain = derivePurse(bindingSignature, 'tally-purse-binding-v2');
    expect(otherSig.toAddress().equals(base.toAddress())).toBe(false);
    expect(otherDomain.toAddress().equals(base.toAddress())).toBe(false);
  });

  it('rejects malformed signatures', () => {
    expect(() => derivePurse(new Uint8Array(63))).toThrow(TxBuildError);
    expect(() => derivePurse(hexToBytes('42'.repeat(64)), '')).toThrow(TxBuildError);
  });
});
