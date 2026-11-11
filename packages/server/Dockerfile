# Build context is the repository root:
#   docker build -f packages/server/Dockerfile .
# docker-compose.yml in this directory sets that up.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# Every workspace manifest is copied so the frozen lockfile matches the
# workspace; only @tally/server and what it depends on is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/app/package.json packages/app/
COPY packages/relay/package.json packages/relay/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @tally/server...
COPY packages/core packages/core
COPY packages/server packages/server
# @tally/core is bundled into dist/ by esbuild; deploy then installs only the
# runtime dependencies next to it.
RUN pnpm --filter @tally/server build \
 && pnpm --filter @tally/server deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read-only to the runtime user.
COPY --from=build /out ./
USER node
EXPOSE 8080
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
