# core/tx

Deterministic settlement transaction construction (PRD 5.4) and purse
derivation (PRD 3.1).

## The invariant this module protects

**Every field of a settlement leg is derived, never observed.** Sender comes
from the purse, recipient and value from the plan, fee is always `0n`, data is
the anchor string, and `validityStartHeight` is **the round's anchor height
from the ROUND_OPEN log entry** — taken from `RoundContext`, nowhere else.

`validityStartHeight` is where this breaks if handled carelessly: two devices
reading the chain three blocks apart would produce different bytes, different
hashes, and therefore **two real payments**. Because every input comes from
the shared signed log, two devices building the same leg produce the same
bytes; Ed25519 signing is deterministic (RFC 8032), so they produce the same
transaction hash, and a second broadcast is a mempool re-broadcast of one
transaction — not a second payment. Nothing in this module reads the chain,
the clock, or any other per-device observation.

Harness Test 2b Part A lives here permanently: `tx.test.ts` builds the same
leg twice from fixed inputs and compares `tx.hash()` and the serialized bytes,
and additionally pins the exact expected bytes as a fixture — if `@nimiq/core`
ever changes the wire encoding, that test fails loudly instead of the field
finding out. `e2e.test.ts` proves the full chain: same log entries in any
order → same state → same plan → same round root → byte-identical legs.

## Purse derivation

`seed = Blake2b(domainSeparator || bindingSignature)`, purse =
`KeyPair.derive(seed)`. Pure and fixture-tested: the same wallet binding
signature always yields the same purse, which is what makes the purse
recoverable on any device from the same account with nothing written down.
The signature's determinism in Nimiq Pay itself is validated by harness
Test 1; if that fails in the field, the fallback is PRD 3.1's random key with
signature-derived backup encryption — a change that happens above this module.

## Guards

- A purse can only sign its own leg (`sender` must match `transfer.from`).
- `networkId` is explicit — `5` (TestAlbatross) or `24` (MainAlbatross) —
  and anything else is rejected. No hidden defaults for money code.
