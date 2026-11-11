import { finalityHeight, verifyPaymentTransaction, type VerificationStatus } from '@tally/core/settle';
import type { PaymentClaim } from '@tally/core/log';
import { RpcError, type ChainSource } from './rpc.js';

export type CheckStatus = VerificationStatus | 'unknown';

export interface ChainCheck {
  status: CheckStatus;
  reason: string | null;
  blockNumber: number | null;
  headHeight: number | null;
  finalityHeight: number | null;
  payloadDigest: string | null;
  checkedAt: Date;
}

export type ClaimToCheck = Pick<PaymentClaim, 'recipient' | 'amount' | 'txHash' | 'ref' | 'network'>;

export function explorerUrl(network: 5 | 24, hash: string): string {
  return network === 24 ? `https://nimiq.watch/#${hash}` : `https://test.nimiq.watch/#${hash}`;
}

/**
 * One fresh look at the chain. An RPC failure is reported as `unknown`, never
 * as any status that could be mistaken for progress.
 */
export async function checkClaim(chain: ChainSource, claim: ClaimToCheck, genesisHash: string): Promise<ChainCheck> {
  let headHeight: number;
  let lookup;
  try {
    headHeight = await chain.getBlockNumber();
    lookup = await chain.getTransactionByHash(claim.txHash);
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    return {
      status: 'unknown',
      reason: `chain RPC unavailable: ${err.message}`,
      blockNumber: null,
      headHeight: null,
      finalityHeight: null,
      payloadDigest: null,
      checkedAt: new Date(),
    };
  }
  const verification = verifyPaymentTransaction({ claim, genesisHash, tx: lookup.tx, headHeight });
  const blockNumber = lookup.tx?.blockNumber && lookup.tx.blockNumber > 0 ? lookup.tx.blockNumber : null;
  return {
    status: verification.status,
    reason: verification.reason,
    blockNumber,
    headHeight,
    finalityHeight: blockNumber === null ? null : finalityHeight(blockNumber),
    payloadDigest: lookup.payloadDigest,
    checkedAt: new Date(),
  };
}
