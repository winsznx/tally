# Adversarial reviews

These are documented because a repo claiming a clean review found nothing is either lucky or not looking.

Every phase of this build ended with a multi-agent adversarial review: several independent reviewers hunting for defects along different axes, then a separate verification pass whose job was to **refute** each finding by reading the code and writing a failing test. Only findings that survived refutation are here. Every one of them was real, and every one is now covered by a test that fails without the fix.

## Phase 1, core modules

### An all-zero signature verified against any message

**What it was.** `@nimiq/core` verifies Ed25519 with the cofactored equation, which accepts small-order public keys. A member could register with the all-zero public key and an all-zero signature, and that pair verifies against *any* message. A phantom member could join a ledger with no account key at all, and their binding attestation would pass.

**How it was found.** A reviewer auditing the binding verifier for cryptographic soundness rather than for code correctness, then constructing the malicious key.

**Why it mattered.** Every accountability claim in the product rests on the binding proving a purse speaks for a real account. A key nobody controls, that validates against everything, makes that proof worthless. This is exactly the class of bug that passes every honest test, because no honest input ever produces a small-order point.

**The fix.** The binding verifier rejects small-order points explicitly before checking the signature.

**Covered by.** `packages/core/core/binding/binding.test.ts`, asserting the all-zero key and the other small-order points are refused.

### Round lifecycle entries were forgeable

**What it was.** The `ROUND_OPEN` and `ROUND_EXPIRE` replay handlers checked that the author was a member, but not that the entry's purse key matched the one registered at that member's join. Any member's address could be used to author a round entry signed by an unrelated key.

**Why it mattered.** `ROUND_OPEN` carries the anchor height that every leg's `validityStartHeight` comes from. Controlling it means controlling transaction bytes.

**The fix.** A single shared guard hoisted above the replay switch, so the check can't be forgotten when a new entry type is added. That shape was chosen deliberately over fixing the two handlers in place.

**Covered by.** `packages/core/core/log/log.test.ts`, including a forged `MEMBER_LEAVE` case added later that the same guard catches for free.

### The commitment layer accepted values the execution layer wraps

**What it was.** Amounts and block heights were validated at the point of use but not at the point of commitment, so the log would accept a value that the transaction layer silently wraps on serialization.

**Why it mattered.** A commitment that says one thing and an execution that does another breaks the property the anchor exists to provide.

**The fix.** Bounds enforced at every boundary: `MAX_LUNA` and `MAX_ANCHOR_HEIGHT` checked in payload validation, not only where the value is consumed.

**Covered by.** Payload-boundary tests rejecting floats, oversized amounts, and heights above the u32 ceiling.

## Phase 0, the validation harness

### The race test would have reported PASS in the exact case it existed to catch

**What it was.** Test 2b Part B polls the chain to count how many payments landed when two devices settle simultaneously. The poll filtered matches by the local device's `validityStartHeight`. In the divergence experiment, where the two devices deliberately read different chain heights, each device's filter excluded the other device's transaction. Both would report exactly one payment. Both would print PASS. Two payments would have landed.

**Why it mattered.** That test's entire purpose is deciding whether the mechanic is safe. A test that inverts its answer in the failure case is worse than no test, because it manufactures confidence.

**The fix.** Drop the height predicate from the filter, report the distinct-hash count of all matches, log each match's height so divergence is visible, and add a recipient balance delta as an independent check that catches a double payment even if the count is wrong.

### A declined dialog surfaced as `[object Object]`

**What it was.** The wallet can reject a dialog by throwing a plain object rather than an `Error`. The message extractor handled `Error` and `ErrorResponse` but fell through to `String(e)` for a bare `{message}`, producing `[object Object]` in the UI.

**Why it mattered.** Declining is a normal outcome, not a failure. Showing a user `[object Object]` for choosing not to approve something is the opposite of the designed behaviour.

**The fix.** The extractor mirrors the resolve path and handles a bare object with a string `message`, so a thrown decline still classifies as declined.

## Phase 5, flows and deploy

### A latecomer joining mid-round caused a second payment

**What it was.** `roundRoot()` and `anchorFor()` built the settlement plan from the **live** member list rather than the membership as of the round that opened. The plan's serialization emits a line for every participant including zero-position ones, so adding a member left the transfer list byte-identical while changing the serialized plan, and therefore the committed root. The root rides in the transaction's data field, so the same leg signed to different bytes with a different hash. The mempool doesn't discard that as a re-broadcast, it executes it as a second payment.

**How it was found.** A reviewer given the specific brief of trying to break the idempotency property, who constructed the scenario rather than reasoning about it: Ada settles a 100,000 Luna debt, a friend scans the invite and joins, Ada's device re-syncs and settles again, and Ada has paid 200,000 Luna.

**Why it mattered.** It needed no offline device, no clock skew and no stale sync. Only "a round is open and somebody joins", which is the normal way a trip ledger grows.

**The fix.** `ROUND_OPEN` pins its participant set, and every round-scoped plan is built from that pinned list.

**Covered by.** `packages/core/core/log/log.test.ts` and `packages/app/src/app/flows.test.ts`, the latter asserting the anchor is unchanged across a mid-round join and that exactly one distinct transaction is broadcast.

### A late acceptance changed the amounts of an already-paid round

**What it was.** A round's consumed obligations were whatever happened to be accepted at the moment `ROUND_OPEN` folded during replay. Replay folds in `(logicalClock, entryId)` order, not arrival order, so an acceptance arriving later with a lower clock joined a round whose money had already moved and changed its leg amounts. In a worse variant it shifted the derived anchor height, so replay rejected the `ROUND_OPEN` entirely and the round was retroactively deleted after payment, leaving two transactions both claiming round 1 with different roots.

**The fix.** `ROUND_OPEN` commits to its consumed obligation ids, and replay settles exactly that set. A late acceptance stays accepted and rolls into the next round.

**Covered by.** `packages/core/core/log/log.test.ts`, asserting a late accept at a lower clock doesn't join the open round.

### The deployed relay would have rejected every append, silently

**What it was.** The app posted an array of JSON strings where the Worker validates an array of objects. Every append would have failed, and because appends fall back to the local cache on failure, the app would have looked fine while every entry lived only on the device that created it.

**How it was found.** A reviewer tracing the app-to-relay seam against the deployed handler rather than against the in-memory fake, which had a different shape and hid the mismatch.

**The fix.** The relay adapter parses before posting.

## What the reviews did not find

Worth stating plainly. The reviews found no issue with the netting engine, which is the module with the most property-based tests and the clearest invariants. That's the intended relationship between test density and defect rate, and it's the reason netting was built first.

Several findings were raised and then **refuted** during verification, and are not listed above: mechanisms that were real but unreachable in the shipped code, and a rate-limiter concern whose stated impact didn't survive testing. Reporting those as fixed bugs would inflate the record, which is the thing this document exists to avoid.
