# @tally/relay

The Tally log transport — a Cloudflare Worker over D1. It moves signed ledger
entries between devices and nothing more.

## What it can and cannot do

**It is untrusted, and the app treats it that way.** Every entry is signed by a
purse key bound to a real account, and clients re-verify every entry on receipt,
so the relay is never a trust anchor.

- **It can** omit entries, reorder them, or go down. The app tolerates all three:
  head-hash comparison surfaces omission/equivocation, canonical replay is
  order-independent, and a dead relay falls back to cached read-only state.
- **It cannot forge.** It cannot invent an entry, alter one, or attribute one to
  someone who did not sign it — that would need a purse key it does not have.

The relay verifies entry signatures (Web Crypto Ed25519 over the canonical
signing text) **only to reject garbage** so it does not store spam. This check
is *not relied upon* for correctness; the code says so in plain words. Workers
have no Blake2b, so the relay never recomputes core's entry ids or hashes — it
treats the client-supplied ids/hashes as opaque dedup keys and cursors.

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `POST /l` | Create a ledger (`{network}` → `{ledgerId, network}`). Ids are 128-bit base32, unguessable. |
| `POST /l/:id/entries` | Append signed entries (`{entries: [...]}`). Idempotent on entryId; garbage rejected. |
| `GET /l/:id/head` | Current head hash (`{head}`). |
| `GET /l/:id/since/:hash` | Entries after the cursor (`{entries: [...]}`); `genesis` for all. |
| `GET /stats` | Distinct account count across all ledgers (`{uniqueAccounts}`) — the only metric (GAP 6). |

No auth, no accounts, no PII. Ledgers are network-scoped (testnet vs mainnet).
Requests are rate-limited per ip (the ip is SHA-256-hashed before storage, so no
raw ip is retained).

## Deploy

```sh
wrangler d1 create tally-relay          # paste database_id into wrangler.toml
pnpm db:init                            # apply schema.sql
pnpm deploy
```

Schema is in [`schema.sql`](schema.sql) (GAP 8): `ledgers`, `entries` (PK
`(ledgerId, entryId)`, indexed on `(ledgerId, receivedAt)`), `heads`, and a
hashed-ip `rate_limit` table.
