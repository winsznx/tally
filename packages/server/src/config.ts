import { z } from 'zod';

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigins: string[];
  nimiqRpcUrl: string;
  networkId: 5 | 24;
  trustProxy: boolean;
  reconcileIntervalMs: number;
  appVersion: string;
}

const origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, 'each CORS origin must be an exact origin such as https://app.example.com, no path, no wildcard');

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(z.array(origin)),
  NIMIQ_RPC_URL: z.url({ protocol: /^https?$/ }).default('https://rpc.nimiqwatch.com'),
  NIMIQ_NETWORK_ID: z.coerce
    .number()
    .pipe(z.union([z.literal(5), z.literal(24)]))
    .default(24),
  TRUST_PROXY: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  APP_VERSION: z.string().min(1).max(64).default('dev'),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Empty values (as left by an env file with names only) mean "use the default". */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    corsOrigins: e.CORS_ORIGINS,
    nimiqRpcUrl: e.NIMIQ_RPC_URL,
    networkId: e.NIMIQ_NETWORK_ID,
    trustProxy: e.TRUST_PROXY,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    appVersion: e.APP_VERSION,
  };
}
