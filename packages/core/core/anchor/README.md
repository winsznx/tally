# core/anchor

The on-chain commitment layer — PRD 3.3. Three things live here:

1. **Wire format** — `TLY1.<ledger8>.<round4>.<i>/<n>.<root27>`, the ASCII
   string carried in each settlement transfer's 64-byte data field. It is 50
   bytes at the PRD's nominal single-digit `i/n` and grows to at most 54 bytes
   at `999/999`; `encodeAnchor` asserts the result never exceeds 64.
2. **Canonical plan serialization** — the exact bytes a round root commits to.
3. **Root chain** — `root(r) = truncate160(Blake2b(root(r-1) ||
   obligationLogRoot(r) || serializePlan(plan(r))))`, with `root(0)` being 32
   zero bytes.

## The invariant this module protects

**An anchor commits to exactly one history.** Rewriting any obligation in any
past round changes that round's root, which changes every subsequent root —
and those roots already sit inside transfers that already settled and cannot
be recalled. `anchor.test.ts` proves the propagation property directly
(tamper with one round-1 obligation → all three roots change); it is a test,
not a claim.

For the commitment to mean anything, the committed bytes must be canonical:

- `serializePlan` refuses non-canonical plans (unsorted participants,
  misaligned positions, non-bigint amounts) instead of normalizing them.
- `encodeAnchor` validates every field range and **fails loudly if the result
  would exceed 64 bytes — it never truncates**.
- `decodeAnchor` is strict: wrong magic, wrong component lengths, invalid or
  non-canonical base32/base64url (including padding bits), leading zeros in
  `i/n`, or `i > n` are all rejected. Decode never guesses.

## Encoding choices (normative)

- `ledger8`: first 5 bytes of the ledger genesis hash, RFC 4648 base32
  (uppercase, no padding) — exactly 8 chars.
- `round4`: 20-bit round counter, same base32 — exactly 4 chars, rounds
  0–1,048,575.
- `i/n`: 1-based decimal transfer index, no leading zeros, `1 ≤ i ≤ n ≤ 999`.
  (Deviation from the PRD's nominal 3-byte `i/n` / 50-byte total: the field is
  variable-length unpadded decimal, so the whole anchor is 50–54 bytes.
  Zero-padding was rejected to keep decode canonical, and the real constraint
  is the 64-byte data field, not the nominal 50. Within the product's own
  bounds — at most 66 transfers for 12 participants in pairwise mode — the
  anchor stays at 52 bytes.)
- `root27`: 20-byte truncated Blake2b-256 (first 160 bits), RFC 4648
  base64url, no padding — exactly 27 chars, final 2 padding bits must be zero.
- Plan bytes: text lines joined by `\n` — `tally-plan-v1`, `m:<mode>`,
  `p:<address>:<position>` per participant in address order,
  `t:<from>:<to>:<amount>` per transfer in plan order. Amounts are decimal
  Luna, never floats.
