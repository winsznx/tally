# core/netting

The netting engine. Takes a set of accepted obligations and produces the
settlement plan: three passes per PRD 3.2 — pairwise collapse, exact cycle
cancellation, greedy min-transfer matching (skipped in `pairwise` mode).

## The invariant this module protects

**Two devices holding the same obligation set must produce the same plan,
and every plan must actually settle.** A plan is only correct if:

1. net positions sum to exactly `0n`,
2. `minimal` mode emits at most `n − 1` transfers,
3. no transfer is a self-transfer,
4. no transfer amount is zero or negative,
5. applying every transfer drives every position to exactly `0n`.

All five are asserted **in production code** on every `computePlan` call
(`InvariantViolation`), not only in tests. If one ever throws, settlement
halts — a plan that fails these is how someone gets double-charged or
short-paid.

## Determinism rules

- Amounts are Luna as `bigint`. A non-bigint amount throws before any
  arithmetic happens. No float ever touches an amount.
- Participants are 20-byte addresses as 40-char lowercase hex, so
  lexicographic order **is** byte order. Every sort and every tie-break in
  this module uses that order — never insertion order, never map order.
- Greedy tie-break: among equal-magnitude debtors (or creditors), the
  smallest address wins. This is what makes two devices emit identical
  transfer lists, which is what makes transaction bytes identical, which is
  what prevents double payment (PRD 5.4).
- Cycle cancellation visits nodes and edges in sorted order, so the residual
  edge set of `pairwise` mode is also device-independent.

`netting.prop.test.ts` generates random 2–12 participant graphs with
fast-check and re-verifies all five invariants independently of the engine's
own asserts, plus full input-permutation determinism. `netting.test.ts`
pins the PRD 3.2 worked example (Ada/Bo/Cy/Dee → two transfers, Cy absent)
as a permanent regression.
