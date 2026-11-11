import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { checkClaim, explorerUrl, type ChainCheck } from '../chain.js';
import { ApiError, parse } from '../errors.js';
import {
  claimOf,
  createIntent,
  insertObservation,
  intentJson,
  latestObservations,
  listIntents,
  markUnknown,
  recordCheck,
  requireIntent,
  submitTransaction,
  type IntentRow,
} from '../intents.js';
import { getTab, replayTab } from '../ledger.js';
import { addressHex, lunaAmount, network, paymentRef, tabId, tabParams, txHash, uuid } from '../schemas.js';

const createIntentBody = z.strictObject({
  tabId,
  payer: addressHex,
  recipient: addressHex,
  amount: lunaAmount,
  ref: paymentRef,
  network,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'must be 8-128 characters of [A-Za-z0-9_-]'),
});
const intentParams = z.object({ id: uuid });
const submissionBody = z.strictObject({ txHash });
const verificationParams = z.object({ hash: txHash });
const verificationQuery = z.object({ tabId });

export function paymentRoutes(ctx: AppContext): FastifyPluginAsync {
  const intentId = (params: unknown): string => parse(intentParams, params, 'invalid_request', 400).id;
  const onTerminal = (row: IntentRow): void => {
    ctx.reconciler.logTerminalIgnored(row);
  };

  return async (app) => {
    app.post('/payment-intents', async (req, reply) => {
      const body = parse(createIntentBody, req.body, 'invalid_body');
      const { intent, created } = await createIntent(ctx.pool, body);
      return reply.code(created ? 201 : 200).send(intentJson(intent));
    });

    app.get('/payment-intents/:id', async (req) => {
      const intent = await requireIntent(ctx.pool, intentId(req.params));
      return { ...intentJson(intent), observations: await latestObservations(ctx.pool, intent.id, 5) };
    });

    app.post('/payment-intents/:id/submission', async (req) => {
      const id = intentId(req.params);
      const body = parse(submissionBody, req.body, 'invalid_body');
      const { intent, changed } = await submitTransaction(ctx.pool, id, body.txHash, ctx.reconciler.leaseMs);
      if (changed) ctx.background(() => ctx.reconciler.checkIntent(id));
      return intentJson(intent);
    });

    app.post('/payment-intents/:id/unknown', async (req) => intentJson(await markUnknown(ctx.pool, intentId(req.params))));

    app.get('/tabs/:tabId/payment-intents', async (req) => {
      const params = parse(tabParams, req.params, 'invalid_tab_id', 400);
      if (!(await getTab(ctx.pool, params.tabId))) throw new ApiError(404, 'tab_not_found', 'no such tab');
      return { intents: (await listIntents(ctx.pool, params.tabId)).map(intentJson) };
    });

    app.get('/transactions/:hash/verification', async (req) => {
      const { hash } = parse(verificationParams, req.params, 'invalid_request', 400);
      const query = parse(verificationQuery, req.query, 'invalid_tab_id', 400);
      if (!(await getTab(ctx.pool, query.tabId))) throw new ApiError(404, 'tab_not_found', 'no such tab');

      const { state } = await replayTab(ctx.pool, query.tabId);
      const claim = state.payments.find((p) => p.txHash === hash);
      let check: ChainCheck;
      let claimNetwork: 5 | 24;
      if (claim && state.genesisHash !== null) {
        check = await checkClaim(ctx.chain, claim, state.genesisHash);
        claimNetwork = claim.network;
        await insertObservation(ctx.pool, {
          intentId: null,
          txHash: hash,
          network: claim.network,
          sourceRpc: ctx.chain.url,
          check,
        });
      } else {
        const { rows } = await ctx.pool.query<IntentRow>(
          'SELECT * FROM payment_intents WHERE tab_id = $1 AND tx_hash = $2',
          [query.tabId, hash],
        );
        const intent = rows[0];
        if (!intent) throw new ApiError(404, 'claim_not_found', 'no payment record or intent in this tab names this transaction');
        check = await checkClaim(ctx.chain, claimOf(intent), intent.genesis_hash);
        claimNetwork = intent.network;
        await recordCheck(ctx.pool, intent.id, check, ctx.chain.url, ctx.config.reconcileIntervalMs, onTerminal);
      }
      return {
        status: check.status,
        reason: check.reason,
        blockNumber: check.blockNumber,
        headHeight: check.headHeight,
        finalityHeight: check.finalityHeight,
        explorerUrl: explorerUrl(claimNetwork, hash),
        checkedAt: check.checkedAt.toISOString(),
      };
    });
  };
}
