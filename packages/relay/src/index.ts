/**
 * Tally relay — Cloudflare Worker. An UNTRUSTED store-and-forward for the signed
 * ledger log. It can omit, reorder, or go down. It CANNOT forge: every entry is
 * signed by a purse key bound to a real account, and clients re-verify every
 * entry, so nothing here is a trust anchor. The signature check below is a spam
 * filter only.
 *
 * No auth, no accounts, no PII. Ledger ids are unguessable (128-bit base32).
 * Rate limited per ip (the ip is hashed before storage).
 */
import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { appendEntries, createLedger, getHead, getSince, getStats } from './handlers.js';
import { D1Store } from './store.js';

interface Env {
  DB: D1Database;
}

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120; // requests per ip per minute

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const store = new D1Store(env.DB);
    const now = Date.now();

    // Per-ip rate limit (ip hashed — no PII stored).
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const ipHash = await sha256Hex(ip);
    const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    if (!(await store.hitRateLimit(ipHash, windowStart, RATE_LIMIT))) {
      return json(429, { error: 'rate limited' });
    }

    try {
      // GET /stats
      if (request.method === 'GET' && parts.length === 1 && parts[0] === 'stats') {
        return respond(await getStats(store));
      }
      // POST /l
      if (request.method === 'POST' && parts.length === 1 && parts[0] === 'l') {
        const body = (await request.json().catch(() => ({}))) as { network?: number };
        return respond(await createLedger(store, body.network ?? 5, now, randomBytes));
      }
      // /l/:id/...
      if (parts[0] === 'l' && parts.length >= 3) {
        const ledgerId = decodeURIComponent(parts[1] as string);
        const sub = parts[2];
        if (request.method === 'POST' && sub === 'entries' && parts.length === 3) {
          const body = (await request.json().catch(() => ({}))) as { entries?: unknown };
          return respond(await appendEntries(store, ledgerId, body.entries, now));
        }
        if (request.method === 'GET' && sub === 'head' && parts.length === 3) {
          return respond(await getHead(store, ledgerId));
        }
        if (request.method === 'GET' && sub === 'since' && parts.length === 4) {
          const cursor = decodeURIComponent(parts[3] as string);
          return respond(await getSince(store, ledgerId, cursor));
        }
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : 'internal error' });
    }
  },
};

function respond(r: { status: number; body: unknown }): Response {
  return json(r.status, r.body);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
