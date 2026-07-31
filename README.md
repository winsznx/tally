# Tally

**Top up once. Stop settling up.**

A shared ledger of obligations among 2–12 people that nets continuously,
clears in NIM without a confirmation dialog per payment, and anchors every
settlement to an append-only on-chain record. Built for the Nimiq Pay Mini
Apps competition.

> Testnet only during development. This repository is public from its first
> commit; treat all history as public.

## Monorepo

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | Pure engine — netting, anchoring, signed log, deterministic tx construction, purse↔account binding. Zero DOM/network/wallet dependency. |
| `packages/app` | The mini app and landing page (one origin). *Added in a later phase.* |
| `packages/relay` | The untrusted log transport. *Added in a later phase.* |

## Development

```sh
pnpm install
pnpm -r test        # vitest, includes fast-check property suites
pnpm -r typecheck
```

## Ground rules

- **Testnet only** until release. Never mainnet in development.
- **BigInt Luna everywhere** (1 NIM = 100,000 Luna). A float touching an
  amount is a bug.
- **Determinism is the product.** Two devices with the same inputs produce
  byte-identical plans and transactions — that is what turns a duplicate
  broadcast into a re-broadcast instead of a double payment.

Full architecture, the security model, and diagrams land in this README as the
build progresses.
