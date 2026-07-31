# core/log

The signed append-only ledger log — PRD 5.5. This is the shared state that
makes deterministic settlement possible: PRD 5.4's byte-identical transaction
construction only works if every device agrees on the accepted-obligation set
and the round's anchor height, and this log is where that agreement lives.

## The invariants this module protects

**Silence is never consent.** An obligation enters the netting input
(`state.acceptedPending`) only when the *named debtor* has signed an
`OBLIGATION_ACCEPT` with their registered purse key. A proposal can sit
unaccepted forever and will never move a single Luna; an accept authored by
anyone else is skipped and recorded. This is tested directly, because it is a
rules-compliance property, not just a product nicety.

**Replay is order-independent.** State derivation deduplicates by entry ID and
folds in `(logicalClock, entryId)` order, so any permutation of the same entry
set yields byte-identical state. Contextually invalid entries (non-member
author, out-of-sequence round, purse-key mismatch) are skipped
deterministically and recorded in `state.ignored` — never silently dropped.

**The head hash commits to the whole history.** Each entry's hash covers its
`prevEntryHash`, so one hash identifies the entire chain; `findDivergence`
walks two chains back to their common ancestor and reports the fork point.

## Structure

- **Entry ID** — `Blake2b(authorAddress || nonce || entryType || payload)`:
  duplicates collapse on arrival. (Deviation from the PRD shorthand: the
  preimage includes `entryType`, preventing cross-type collisions.)
- **Entry hash** — Blake2b over the canonical signing bytes plus signature;
  this is what `prevEntryHash` and the head hash refer to.
- **Signing bytes** — a versioned canonical text serialization
  (`tally-log-entry-v1`); payloads are canonical JSON with sorted keys, and
  amounts are decimal Luna **strings** — floats are rejected at the boundary.
- **Rounds** — `ROUND_OPEN {round, anchorHeight, mode}` consumes the accepted
  set (recording `consumedAcceptIds` for `obligationLogRoot`) and is the ONLY
  legitimate source of `validityStartHeight` for `core/tx`. `ROUND_EXPIRE`
  returns the obligations for replanning.
- **`obligationLogRoot`** — Merkle root over consumed accept-entry IDs:
  sorted leaves, `Blake2b(0x00 || id)` leaf / `Blake2b(0x01 || l || r)` node,
  odd node promoted, empty set → 32 zero bytes.

The wallet binding attestation that ties a purse key to an account is verified
at registration — `LEDGER_OPEN` and `MEMBER_JOIN` carry it and replay rejects
any whose attestation does not verify (see [`../binding`](../binding/)). After
registration a single shared guard requires every later entry from that account
to carry the registered purse key.

Still out of scope here, tracked as issues rather than TODOs: purse-key
rotation, and a `CONTESTED → VOIDED` resolution entry type.
