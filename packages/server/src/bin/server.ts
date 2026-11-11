import { pino } from 'pino';
import { buildApp } from '../app.js';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { Reconciler } from '../reconciler.js';
import { NimiqRpc } from '../rpc.js';

const log = pino({ level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] });

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, (err) => log.error({ err }, 'idle database client error'));
  const chain = new NimiqRpc({ url: config.nimiqRpcUrl });
  const reconciler = new Reconciler({ pool, chain, log, intervalMs: config.reconcileIntervalMs });
  const app = await buildApp({ config, pool, chain, reconciler, logger: log });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error('shutdown timed out');
      process.exit(1);
    }, 20_000);
    force.unref();
    await reconciler.stop();
    await app.close();
    await pool.end();
    log.info('stopped');
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      shutdown(signal).catch((err: unknown) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
    });
  }

  await app.listen({ port: config.port, host: config.host });
  reconciler.start();
  log.info(
    { version: config.appVersion, network: config.networkId, rpc: config.nimiqRpcUrl, corsOrigins: config.corsOrigins.length },
    'tally api started',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) log.fatal(err.message);
  else log.fatal({ err }, 'failed to start');
  process.exit(1);
});
