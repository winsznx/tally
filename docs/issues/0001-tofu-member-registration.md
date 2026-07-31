# Trust-on-first-use at member registration

**Status:** accepted for v1 (known limitation, documented in [SECURITY.md](../../SECURITY.md))
**Labels:** security, known-limitation, v2
**Type:** hardening, not a bug

> This file is a tracked issue kept in-repo because the project has no GitHub
> remote yet. Transfer it to GitHub Issues verbatim when the repository is
> pushed.

## Summary

Member registration is authenticated (each `MEMBER_JOIN` carries a binding
attestation proving the account authorised the purse), but the **human ↔
account** mapping and the **completeness of the member set** are trusted on
first use. A malicious relay cannot forge a member, but it can equivocate on the
member set at a client's very first sync, before any cross-check exists.

## What is and isn't guaranteed

- Guaranteed: every registered member controls the account their purse is bound
  to. No entry can be attributed to a non-signer. The purse-balance money bound
  is unaffected.
- Not guaranteed at first use: that account X is the human you expect, or that
  the presented member set is complete.

## Impact

Low for v1. TOFU on the member set cannot move funds or forge an obligation. The
worst case is a confusing/misattributed member list until an out-of-band check
or an on-chain reconciliation exposes the divergence.

## Existing mitigations (already shipped)

- Binding attestation on every registration (authenticated membership).
- Head-hash comparison on every sync; divergent heads surface within seconds.
- Out-of-band member-list / head-hash comparison (needs no relay cooperation).
- On-chain settlement reconciliation and fork detection (PRD 5.5).

## Candidate hardening for a future version

- A member-set commitment signed by existing members when a new member is
  admitted (quorum-attested membership), so omission/insertion is detectable
  without out-of-band comparison.
- Surfacing a short, comparable "ledger safety code" (à la Signal safety
  numbers) in the UI for out-of-band verification.
- Anchoring the member-set root on-chain alongside settlement roots.

## Why not fixed now

TOFU is the standard, well-understood bootstrap trade-off (SSH `known_hosts`,
Signal safety numbers, certificate transparency). Fixing it properly (quorum
attestation or on-chain member-set anchoring) is a larger design that does not
change the v1 money boundary, so it is deferred deliberately rather than papered
over.
