import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { ApiError, parse } from '../errors.js';
import { newTabId } from '../ids.js';
import { appendEntries, entryPage, getTab, tabCounts, tabSummary, type TabRow } from '../ledger.js';
import { network, seqCursor, tabParams } from '../schemas.js';

const createTabBody = z.strictObject({ network });
const pageQuery = z.object({
  after: seqCursor.default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
const appendBody = z.object({ entries: z.array(z.unknown()).min(1).max(100) });

export function tabRoutes(ctx: AppContext): FastifyPluginAsync {
  const requireTab = async (params: unknown): Promise<TabRow> => {
    const { tabId } = parse(tabParams, params, 'invalid_tab_id', 400);
    const tab = await getTab(ctx.pool, tabId);
    if (!tab) throw new ApiError(404, 'tab_not_found', 'no such tab');
    return tab;
  };

  return async (app) => {
    app.post('/tabs', async (req, reply) => {
      const body = parse(createTabBody, req.body, 'invalid_body');
      if (body.network !== ctx.config.networkId) {
        throw new ApiError(422, 'network_mismatch', `this server serves network ${ctx.config.networkId}`);
      }
      const { rows } = await ctx.pool.query<TabRow>(
        'INSERT INTO tabs (id, network) VALUES ($1, $2) RETURNING id, network, created_at',
        [newTabId(), body.network],
      );
      const tab = rows[0] as TabRow;
      return reply.code(201).send({ tabId: tab.id, network: tab.network, createdAt: tab.created_at.toISOString() });
    });

    app.get('/tabs/:tabId', async (req) => {
      const tab = await requireTab(req.params);
      const counts = await tabCounts(ctx.pool, tab.id);
      return { tabId: tab.id, network: tab.network, createdAt: tab.created_at.toISOString(), ...counts };
    });

    app.get('/tabs/:tabId/entries', async (req) => {
      const tab = await requireTab(req.params);
      const query = parse(pageQuery, req.query, 'invalid_request', 400);
      return entryPage(ctx.pool, tab.id, query.after, query.limit);
    });

    app.post(
      '/tabs/:tabId/entries',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req) => {
        const { tabId } = parse(tabParams, req.params, 'invalid_tab_id', 400);
        const body = parse(appendBody, req.body, 'invalid_body');
        const result = await appendEntries(ctx.pool, tabId, body.entries);
        if (!result) throw new ApiError(404, 'tab_not_found', 'no such tab');
        req.log.info(
          { tabId, accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected.length },
          'entries appended',
        );
        return result;
      },
    );

    app.get('/tabs/:tabId/summary', async (req) => {
      const tab = await requireTab(req.params);
      return tabSummary(ctx.pool, tab.id);
    });
  };
}
