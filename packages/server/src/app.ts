import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { ApiError } from './errors.js';
import type { Reconciler } from './reconciler.js';
import { paymentRoutes } from './routes/payments.js';
import { systemRoutes } from './routes/system.js';
import { tabRoutes } from './routes/tabs.js';
import type { ChainSource } from './rpc.js';
import { StatsCache } from './stats.js';

export const BODY_LIMIT_BYTES = 256 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface AppDeps {
  config: Config;
  pool: Pool;
  chain: ChainSource;
  reconciler: Reconciler;
  logger?: FastifyBaseLogger;
}

export interface AppContext {
  config: Config;
  pool: Pool;
  chain: ChainSource;
  reconciler: Reconciler;
  stats: StatsCache;
  /** Runs work after the response; the server waits for it on close. */
  background(task: () => Promise<unknown>): void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: deps.config.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID_RE.test(given) ? given : randomUUID();
    },
    return503OnClosing: true,
  });

  // Set before any plugin registers routes: a route captures the error handler in force when it is added.
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const mapped = mapFrameworkError(err);
    if (mapped) return reply.code(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } });
  });

  const pending = new Set<Promise<unknown>>();
  const ctx: AppContext = {
    config: deps.config,
    pool: deps.pool,
    chain: deps.chain,
    reconciler: deps.reconciler,
    stats: new StatsCache(deps.pool),
    background(task) {
      const p = Promise.resolve()
        .then(task)
        .catch((err: unknown) => app.log.error({ err }, 'background task failed'))
        .finally(() => pending.delete(p));
      pending.add(p);
    },
  };
  app.addHook('onClose', async () => {
    await Promise.allSettled([...pending]);
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  const allowed = new Set(deps.config.corsOrigins);
  await app.register(cors, {
    // Requests without an Origin header are not cross-origin browser requests; let them through untouched.
    origin: (origin, cb) => {
      if (origin === undefined) cb(null, false);
      else if (allowed.has(origin)) cb(null, true);
      else cb(new ApiError(403, 'origin_not_allowed', 'this origin is not allowed'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, info) => new ApiError(429, 'rate_limited', `rate limit exceeded, retry in ${info.after}`),
  });

  await app.register(systemRoutes(ctx));
  await app.register(tabRoutes(ctx), { prefix: '/api/v1' });
  await app.register(paymentRoutes(ctx), { prefix: '/api/v1' });
  return app;
}

function mapFrameworkError(err: FastifyError): ApiError | null {
  switch (err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ApiError(413, 'payload_too_large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`);
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ApiError(415, 'unsupported_media_type', 'send application/json');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new ApiError(422, 'invalid_body', 'request body is not valid JSON');
  }
  if (err.statusCode === 400 && err instanceof SyntaxError) {
    return new ApiError(422, 'invalid_body', 'request body is not valid JSON');
  }
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    return new ApiError(err.statusCode, 'bad_request', 'malformed request');
  }
  return null;
}
