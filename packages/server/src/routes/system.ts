import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { ApiError, parse } from '../errors.js';

export const CONSENTED_EVENTS = [
  'app_opened',
  'wallet_connected',
  'tab_created',
  'tab_joined',
  'expense_recorded',
  'share_accepted',
  'share_declined',
  'payment_started',
  'payment_submitted',
  'payment_confirmed',
  'payment_declined',
] as const;

const consentedEvent = z.strictObject({
  event: z.enum(CONSENTED_EVENTS),
  installId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'must be 16-64 characters of [A-Za-z0-9_-]'),
  appVersion: z.string().regex(/^[0-9A-Za-z.+_-]{1,32}$/, 'must be 1-32 characters of [0-9A-Za-z.+_-]'),
});

export function systemRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async (req, reply) => {
      try {
        await ctx.pool.query('SELECT 1');
      } catch (err) {
        req.log.warn({ err }, 'health check: database unreachable');
        throw new ApiError(503, 'db_unavailable', 'database unreachable');
      }
      return reply.send({ ok: true, version: ctx.config.appVersion });
    });

    app.get('/ready', async (req, reply) => {
      const [db, head] = await Promise.allSettled([ctx.pool.query('SELECT 1'), ctx.chain.getBlockNumber()]);
      if (db.status === 'rejected') req.log.warn({ err: db.reason }, 'readiness: database unreachable');
      if (head.status === 'rejected') req.log.warn({ err: head.reason }, 'readiness: chain RPC unreachable');
      const body = {
        db: db.status === 'fulfilled' ? 'ok' : 'error',
        chain: head.status === 'fulfilled' ? 'ok' : 'error',
        head: head.status === 'fulfilled' ? head.value : null,
      };
      return reply.code(body.db === 'ok' && body.chain === 'ok' ? 200 : 503).send(body);
    });

    app.get('/api/v1/stats', async () => ctx.stats.get());

    app.post(
      '/api/v1/metrics/consented-event',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const body = parse(consentedEvent, req.body, 'invalid_body');
        await ctx.pool.query('INSERT INTO client_events (event, install_id, app_version) VALUES ($1, $2, $3)', [
          body.event,
          body.installId,
          body.appVersion,
        ]);
        return reply.code(202).send({ accepted: true });
      },
    );
  };
}
