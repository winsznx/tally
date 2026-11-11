# @tally/server

HTTP API for Tally on Node and PostgreSQL. It replaces the Cloudflare Worker in
`packages/relay`.

The server is an untrusted transport, index and read model. It stores signed
ledger entries, indexes payment intents and records what the chain said about
them. It holds no keys, never creates, edits or deletes a signed entry, and
never builds or broadcasts a transaction. Clients re-verify everything it
returns.

On append it runs core's `validateEntry`, computes `entryId` and `entryHash`
itself, and rejects entries that replay would skip because the author is not a
member. Payment checks use core's `verifyPaymentTransaction` against the
Albatross JSON-RPC. An RPC failure is reported as `unknown`, never as progress.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgresql://user:pass@host:5432/db` |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `CORS_ORIGINS` | empty | Comma-separated exact origins. No wildcard. Other browser origins get 403. |
| `NIMIQ_RPC_URL` | `https://rpc.nimiqwatch.com` | Read-only calls: `getBlockNumber`, `getTransactionByHash` |
| `NIMIQ_NETWORK_ID` | `24` | `24` mainnet or `5` testnet. Tabs on the other network are refused. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limits see client IPs. |
| `RECONCILE_INTERVAL_MS` | `15000` | Reconciler tick and base of the per-intent backoff (capped at 10 min). |
| `APP_VERSION` | `dev` | Returned by `/health`. |

Empty values count as unset. Invalid config stops the process at boot.

## Run locally

```sh
pnpm install
pnpm --filter @tally/server build
export DATABASE_URL=postgresql://localhost:5432/tally
pnpm --filter @tally/server migrate
pnpm --filter @tally/server start
```

Tests need a local PostgreSQL. Each test file creates and drops its own
`tally_test_*` database through `postgresql://localhost:5432/postgres`, or
`TEST_DATABASE_ADMIN_URL` if set. The chain RPC is faked.

```sh
pnpm --filter @tally/server test
```

## Docker

```sh
cd packages/server
cp .env.example .env    # set POSTGRES_PASSWORD (URL-safe, e.g. openssl rand -hex 24) and CORS_ORIGINS
docker compose up -d --build
```

The compose project is named `tally`. The API binds `127.0.0.1:${TALLY_API_PORT:-8797}`
and PostgreSQL publishes no port. The container applies pending migrations
before it starts.

## Migrations

Numbered files in `migrations/` run in order, each in its own transaction, and
are recorded in `schema_migrations`. An advisory lock serialises concurrent
runners. `node dist/migrate.js` applies whatever is pending.

## Recheck

```sh
node dist/recheck.js [--tab <tabId>] [--intent <uuid>]
```

Re-verifies every non-terminal intent that has a transaction hash, once, and
prints one JSON line per intent. It only reads from the chain.

## Endpoints

Errors are `{ "error": { "code", "message" } }`. Every response carries
`x-request-id`. Rate limits are 300/min per IP overall, 60/min for appends and
20/min for metrics.

| Method and path | Result |
| --- | --- |
| `GET /health` | `{ ok, version }` once `select 1` succeeds, else 503 |
| `GET /ready` | `{ db, chain, head }`, 503 if either is down |
| `POST /api/v1/tabs` | `{ network }` → 201 `{ tabId, network, createdAt }` |
| `GET /api/v1/tabs/:tabId` | `{ tabId, network, createdAt, entryCount, headSeq }` |
| `GET /api/v1/tabs/:tabId/entries?after=&limit=` | `{ entries: [{ seq, entryId, entryHash, entryJson, receivedAt }], nextAfter }` |
| `POST /api/v1/tabs/:tabId/entries` | `{ entries }` (1 to 100) → `{ accepted, duplicates, rejected: [{ index, code, message }] }` |
| `GET /api/v1/tabs/:tabId/summary` | Replay-derived counts, `cached: true`. Not for money. |
| `GET /api/v1/tabs/:tabId/payment-intents` | `{ intents }`, newest first |
| `POST /api/v1/payment-intents` | 201 new or 200 existing intent, 409 `intent_conflict` |
| `GET /api/v1/payment-intents/:id` | Intent with the latest 5 `observations` |
| `POST /api/v1/payment-intents/:id/submission` | `{ txHash }` → `submitted`, 409 `hash_conflict` |
| `POST /api/v1/payment-intents/:id/unknown` | `created` → `unknown` |
| `GET /api/v1/transactions/:hash/verification?tabId=` | Fresh chain check: `{ status, reason, blockNumber, headHeight, finalityHeight, explorerUrl, checkedAt }` |
| `POST /api/v1/metrics/consented-event` | `{ event, installId, appVersion }` → 202 |
| `GET /api/v1/stats` | Aggregates only, cached for 60 s |

Intent states: `created`, `submitted`, `observed`, then one of the terminal
`confirmed`, `failed`, `mismatch`. `unknown` means the client lost the wallet
response. Terminal states never change, and nothing moves backwards.
