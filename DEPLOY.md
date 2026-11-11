# Deploying Tally

Two pieces: a static frontend on Vercel, deployed from the command line with no Git integration, and the API with its Postgres on a Docker host.

## API (Docker host)

```bash
rsync -az --exclude node_modules --exclude .git --exclude /internal ./ host:/srv/tally/
ssh host
cd /srv/tally/packages/server
cp .env.example .env    # set POSTGRES_PASSWORD (random), CORS_ORIGINS (exact frontend origin), NIMIQ_NETWORK_ID=24, TRUST_PROXY=true
docker compose up -d --build
curl -s 127.0.0.1:8797/health   # {"ok":true,...}
curl -s 127.0.0.1:8797/ready    # db and chain both "ok"
```

The container runs migrations before starting. It binds to `127.0.0.1:8797` only; put TLS in front with your reverse proxy. If that proxy is a container on a shared Docker network, add the override so the proxy can reach the API as `tally-api:8080`:

```bash
PROXY_NETWORK=<network> docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

Caddy example:

```
tally-api.example.com {
	request_body {
		max_size 1MB
	}
	reverse_proxy tally-api:8080
}
```

Re-check payments that are not final yet (never sends anything): `docker compose exec api node dist/recheck.js`.

Back up the database with `docker compose exec db pg_dump -U tally tally > tally-$(date +%F).sql`. The signed entries are the source of truth; everything else can be rebuilt from them and from the chain.

## Frontend (Vercel CLI)

```bash
cd packages/app
VITE_API_URL=https://<api host> VITE_NIMIQ_NETWORK=mainnet VITE_APP_VERSION=$(git rev-parse --short HEAD) pnpm build
cp vercel.json dist/
mkdir -p ../../.deploy/tally && rsync -a --delete --exclude .vercel dist/ ../../.deploy/tally/
cd ../../.deploy/tally && vercel deploy --prod --yes
```

Only public values go in `VITE_` variables. Afterwards set the API's `CORS_ORIGINS` to the production origin and restart it.

## Production today

- Frontend: https://tally-neon-chi.vercel.app
- API: https://tally-api.158.220.85.120.sslip.io
- Network: Nimiq mainnet

The Cycle I deployment (Cloudflare Pages and a Worker relay on testnet) is retired; `packages/relay` is kept for reference.
