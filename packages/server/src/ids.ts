import { randomBytes } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const TAB_ID_RE = /^[a-z2-7]{26}$/;

/** 128 CSPRNG bits as 26 lowercase base32 characters; same algorithm as the relay's ledger ids. */
export function newTabId(random: (n: number) => Uint8Array = randomBytes): string {
  let bits = 0n;
  for (const b of random(16)) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = BASE32[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}
