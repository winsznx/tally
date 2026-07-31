# Deploying Tally

Everything runs on Cloudflare: the origin (landing + mini app) on **Pages**, the
log relay on **Workers + D1**. HTTPS and a `*.pages.dev` domain come free; a
custom domain can be added later and changes nothing structural.

## The whole thing, from a clean checkout

```sh
npx wrangler login      # the only interactive step
./scripts/deploy.sh     # everything else
```

That script is idempotent — re-run it to redeploy. It:

1. installs dependencies and runs the full test suite (a failing build never ships),
2. creates the D1 database if it does not exist and writes its id into
   `packages/relay/wrangler.toml`,
3. applies the checked-in migrations in `packages/relay/migrations/`,
4. deploys the relay Worker and captures its public URL,
5. builds the app with `VITE_RELAY_URL` set to that relay,
6. deploys the app to Cloudflare Pages.

It prints the app URL, the relay URL, and the `/stats` endpoint at the end.

## There are no secrets

**Nothing in this repository is secret, and nothing needs to be.** No API keys,
no tokens, no `.env` file, no `wrangler secret put`. This is a deliberate
property of the architecture, not an oversight:

- The relay stores only **signed public entries** and is **untrusted by design**
  — clients re-verify every entry, so a leaked copy of its database would reveal
  nothing that is not already public on-chain, and grant no ability to forge.
- The purse key is **generated at runtime on the device** and never leaves it or
  enters this repository.
- The D1 `database_id` in `wrangler.toml` is an account-scoped **resource
  handle**, not a credential: it is useless without your Cloudflare login.
- Endpoints (relay, public RPC) are public URLs, injected at build time so they
  can vary per environment — not because they are sensitive.

The only credential involved anywhere is your own `wrangler login`, which lives
in your local Cloudflare config and never touches the repo.

## Pointing a build at a different relay

The relay URL is a **build-time variable**, never hardcoded:

```sh
VITE_RELAY_URL=https://tally-relay-preview.<subdomain>.workers.dev \
  pnpm --filter @tally/app build
npx wrangler pages deploy packages/app/dist --project-name tally --branch preview
```

`VITE_TESTNET_RPC_URL` and `VITE_MAINNET_RPC_URL` work the same way if you want
to point at your own Nimiq node instead of the public ones.

## Doing it by hand

```sh
pnpm install

# 1. Database
npx wrangler d1 create tally-relay              # paste the id into packages/relay/wrangler.toml
pnpm --filter @tally/relay db:migrate           # applies migrations/*.sql to the remote DB

# 2. Relay
pnpm --filter @tally/relay deploy               # prints https://tally-relay.<subdomain>.workers.dev

# 3. App
VITE_RELAY_URL=<that relay URL> pnpm --filter @tally/app build
npx wrangler pages deploy packages/app/dist --project-name tally --branch main
```

## Local development

```sh
pnpm --filter @tally/relay dev     # relay on http://localhost:8787 (the app's default)
pnpm --filter @tally/app dev       # origin on http://localhost:5174
```

`pnpm --filter @tally/relay db:migrate:local` seeds a local D1 for `wrangler dev`.

## Verifying a deploy

| Check | Expectation |
| --- | --- |
| Open the Pages URL on desktop | The **landing page** renders (no `window.nimiqPay`). |
| Open `<pages-url>/?app=1` | The **mini app** half renders instead. |
| Open `<pages-url>/l/<anything>` | Still the app shell — the SPA rewrite works, invite links resolve. |
| `curl <relay-url>/stats` | `{"uniqueAccounts":0}` |
| Nimiq Pay → Mini Apps → Custom URL → Pages URL | The mini app loads over HTTPS (a secure context, so `crypto.randomUUID` is available). |
