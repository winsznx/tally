# @tally/core

The pure core of [Tally](./): a shared ledger of obligations that nets
continuously, clears in NIM without confirmation dialogs, and anchors every
settlement to an append-only on-chain record.

Four modules, zero DOM dependency, fully testable under Node:

| Module | What it is | The invariant it protects |
| --- | --- | --- |
| [`core/netting`](core/netting/) | The 3-pass netting engine | Positions sum to zero; identical plans on every device |
| [`core/anchor`](core/anchor/) | wire format (≤54 bytes) + root chain | An anchor commits to exactly one history |
| [`core/log`](core/log/) | Signed append-only ledger log | Silence is never consent; replay is order-independent |
| [`core/tx`](core/tx/) | Deterministic tx construction | Same log ⇒ same bytes ⇒ one payment, never two |

Each module's README states its invariant precisely. Two rules hold
everywhere:

- **Integer arithmetic only.** Amounts are Luna as `bigint`
  (1 NIM = 100,000 Luna). Floats are rejected at every boundary.
- **Determinism is the product.** Every function that produces bytes or a
  plan is a pure function of its inputs — no arrival order, no map order, no
  clock, no locale. This is what makes a duplicate broadcast a re-broadcast
  instead of a double payment.

```sh
npm install
npm test        # vitest, includes fast-check property suites
npm run typecheck
```

The UI imports these modules (`@tally/core/netting` etc.); they import
nothing from the UI. Ed25519 and Blake2b come from `@nimiq/core`, which runs
as WASM under Node.
