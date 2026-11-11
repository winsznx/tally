import { z } from 'zod';
import { TAB_ID_RE } from './ids.js';

export const MAX_SAFE_LUNA = BigInt(Number.MAX_SAFE_INTEGER);

export const tabId = z.string().regex(TAB_ID_RE, 'must be 26 characters of [a-z2-7]');
export const addressHex = z.string().regex(/^[0-9a-f]{40}$/, 'must be 40 lowercase hex characters');
export const txHash = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
export const paymentRef = z.string().regex(/^[a-z2-7]{16}$/, 'must be 16 characters of [a-z2-7]');
export const network = z.union([z.literal(5), z.literal(24)]);
export const lunaAmount = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, 'must be a positive integer Luna string')
  .refine((v) => /^[0-9]+$/.test(v) && BigInt(v) <= MAX_SAFE_LUNA, `must be at most ${MAX_SAFE_LUNA}`);
export const seqCursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, 'must be a non-negative integer');
export const uuid = z.uuid();

export const tabParams = z.object({ tabId });
