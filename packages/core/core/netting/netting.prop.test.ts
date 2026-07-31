import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computePlan,
  netPositions,
  type AddressHex,
  type Obligation,
  type SettlementPlan,
} from './index.js';

const stringify = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

const addrArb = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));

const graphArb = fc
  .uniqueArray(addrArb, { minLength: 2, maxLength: 12 })
  .chain((participants) =>
    fc.tuple(
      fc.constant(participants),
      fc.array(
        fc
          .tuple(
            fc.nat(participants.length - 1),
            fc.nat(participants.length - 2),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
          )
          .map(([di, cj, amount]): Obligation => {
            const debtor = participants[di] as AddressHex;
            const creditor = participants[cj >= di ? cj + 1 : cj] as AddressHex;
            return { debtor, creditor, amount };
          }),
        { maxLength: 40 },
      ),
    ),
  );

/** Independent re-verification — deliberately does not trust the engine's own asserts. */
function verifyInvariants(plan: SettlementPlan, participants: string[]): void {
  const n = participants.length;
  let sum = 0n;
  for (const p of plan.positions) sum += p.position;
  expect(sum).toBe(0n);

  const bound = plan.mode === 'minimal' ? n - 1 : (n * (n - 1)) / 2;
  expect(plan.transfers.length).toBeLessThanOrEqual(bound);

  const residual = new Map(plan.positions.map((p) => [p.address, p.position]));
  for (const t of plan.transfers) {
    expect(t.from).not.toBe(t.to);
    expect(t.amount > 0n).toBe(true);
    residual.set(t.from, (residual.get(t.from) ?? 0n) + t.amount);
    residual.set(t.to, (residual.get(t.to) ?? 0n) - t.amount);
  }
  for (const [, r] of residual) expect(r).toBe(0n);
}

describe('netting properties (fast-check)', () => {
  it('all five invariants hold for random graphs in minimal mode', () => {
    fc.assert(
      fc.property(graphArb, ([participants, obligations]) => {
        verifyInvariants(computePlan(participants, obligations, 'minimal'), participants);
      }),
      { numRuns: 300 },
    );
  });

  it('all invariants hold for random graphs in pairwise mode', () => {
    fc.assert(
      fc.property(graphArb, ([participants, obligations]) => {
        verifyInvariants(computePlan(participants, obligations, 'pairwise'), participants);
      }),
      { numRuns: 300 },
    );
  });

  it('the plan is identical under any input permutation', () => {
    fc.assert(
      fc.property(
        graphArb.chain(([participants, obligations]) =>
          fc.tuple(
            fc.constant(participants),
            fc.constant(obligations),
            fc.shuffledSubarray(participants, { minLength: participants.length, maxLength: participants.length }),
            fc.shuffledSubarray(obligations, { minLength: obligations.length, maxLength: obligations.length }),
          ),
        ),
        ([participants, obligations, shuffledParticipants, shuffledObligations]) => {
          for (const mode of ['minimal', 'pairwise'] as const) {
            expect(stringify(computePlan(shuffledParticipants, shuffledObligations, mode))).toBe(
              stringify(computePlan(participants, obligations, mode)),
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('positions are mode-independent and match netPositions', () => {
    fc.assert(
      fc.property(graphArb, ([participants, obligations]) => {
        const positions = stringify(netPositions(participants, obligations));
        expect(stringify(computePlan(participants, obligations, 'minimal').positions)).toBe(positions);
        expect(stringify(computePlan(participants, obligations, 'pairwise').positions)).toBe(positions);
      }),
      { numRuns: 200 },
    );
  });

  it('greedy never produces more transfers than participants with nonzero positions minus one', () => {
    fc.assert(
      fc.property(graphArb, ([participants, obligations]) => {
        const plan = computePlan(participants, obligations, 'minimal');
        const active = plan.positions.filter((p) => p.position !== 0n).length;
        expect(plan.transfers.length).toBeLessThanOrEqual(Math.max(0, active - 1));
      }),
      { numRuns: 300 },
    );
  });
});
