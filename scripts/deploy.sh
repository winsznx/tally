#!/usr/bin/env bash
#
# Tally — full deploy to Cloudflare, from a clean checkout.
#
#   Prerequisite: `npx wrangler login` (the only interactive step).
#   Then:         ./scripts/deploy.sh
#
# It is idempotent: re-running redeploys both halves without duplicating
# resources. There are NO secrets — nothing below reads a key, token, or .env.
#
# What it does, in order:
#   1. install dependencies and run the test suite (a broken build never ships)
#   2. create the D1 database if it does not exist, and write its id into
#      packages/relay/wrangler.toml
#   3. apply checked-in D1 migrations (reproducible schema)
#   4. deploy the relay Worker and capture its public URL
#   5. build the app with VITE_RELAY_URL pointing at that relay
#   6. deploy the app (landing + mini app) to Cloudflare Pages
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
RELAY_DIR="$ROOT/packages/relay"
APP_DIR="$ROOT/packages/app"
DB_NAME="tally-relay"
PAGES_PROJECT="${PAGES_PROJECT:-tally}"
WRANGLER="npx --yes wrangler@4"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

say "Checking Cloudflare login"
if ! $WRANGLER whoami 2>&1 | grep -qi 'account'; then
  echo "Not logged in. Run:  npx wrangler login" >&2
  exit 1
fi

say "Installing dependencies"
pnpm install --frozen-lockfile

say "Running the test suite"
pnpm -r test

say "Ensuring the D1 database exists"
DB_ID="$($WRANGLER d1 list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const m=l.find(d=>d.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.database_id||""):"")}catch{process.stdout.write("")}})' "$DB_NAME" || true)"

if [ -z "$DB_ID" ]; then
  echo "Creating D1 database '$DB_NAME'…"
  CREATE_OUT="$($WRANGLER d1 create "$DB_NAME" 2>&1)"
  echo "$CREATE_OUT"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
fi

if [ -z "$DB_ID" ]; then
  echo "Could not determine the D1 database id. Create it manually:" >&2
  echo "  npx wrangler d1 create $DB_NAME" >&2
  echo "then paste the id into packages/relay/wrangler.toml and re-run." >&2
  exit 1
fi
echo "D1 database id: $DB_ID"

# Write the id into wrangler.toml (it is a resource handle, not a secret).
node -e '
const fs = require("fs");
const p = process.argv[1], id = process.argv[2];
const s = fs.readFileSync(p, "utf8").replace(/database_id = "[^"]*"/, `database_id = "${id}"`);
fs.writeFileSync(p, s);
' "$RELAY_DIR/wrangler.toml" "$DB_ID"

say "Applying D1 migrations"
(cd "$RELAY_DIR" && $WRANGLER d1 migrations apply "$DB_NAME" --remote)

say "Deploying the relay Worker"
RELAY_OUT="$(cd "$RELAY_DIR" && $WRANGLER deploy 2>&1)"
echo "$RELAY_OUT"
RELAY_URL="$(printf '%s' "$RELAY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
if [ -z "$RELAY_URL" ]; then
  echo "Could not parse the relay URL from the deploy output." >&2
  echo "Set it manually and re-run the app build:  VITE_RELAY_URL=<url> pnpm --filter @tally/app build" >&2
  exit 1
fi
echo "Relay: $RELAY_URL"

say "Building the app against $RELAY_URL"
(cd "$APP_DIR" && VITE_RELAY_URL="$RELAY_URL" pnpm build)

say "Deploying the app to Cloudflare Pages"
$WRANGLER pages project create "$PAGES_PROJECT" --production-branch main 2>/dev/null || true
PAGES_OUT="$($WRANGLER pages deploy "$APP_DIR/dist" --project-name "$PAGES_PROJECT" --branch main 2>&1)"
echo "$PAGES_OUT"
# Prefer the STABLE alias (https://<project>.pages.dev) over the per-deployment
# preview URL, which changes every deploy and is useless as a Demo URL.
PAGES_URL="$(printf '%s' "$PAGES_OUT" | grep -oE "https://${PAGES_PROJECT}\\.pages\\.dev" | head -1)"
if [ -z "$PAGES_URL" ]; then PAGES_URL="https://${PAGES_PROJECT}.pages.dev"; fi

say "Done"
echo "  App:   ${PAGES_URL:-see output above}"
echo "  Relay: $RELAY_URL"
echo "  Stats: $RELAY_URL/stats"
echo
echo "Load the app URL in Nimiq Pay: Discover → "Search or enter App URL"."
