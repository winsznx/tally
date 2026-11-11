/**
 * Client for the Tally API. The API is an untrusted transport and index: every
 * entry it returns is re-verified locally, and nothing it says about payments is
 * taken as proof (see payments.ts for the independent chain check).
 */
import type { LogEntry } from '@tally/core/log';
import { API_URL } from './config.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiUnreachable extends Error {
  constructor() {
    super('Tally’s server could not be reached.');
    this.name = 'ApiUnreachable';
  }
}

export interface StoredEntryRow {
  seq: string;
  entryId: string;
  entryHash: string;
  entryJson: string;
  receivedAt: string;
}

export interface AppendResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; code: string; message: string }[];
}

export interface ServerIntent {
  id: string;
  tabId: string;
  payer: string;
  recipient: string;
  amount: string;
  ref: string;
  memo: string;
  network: number;
  txHash: string | null;
  state: string;
}

export interface ServerVerification {
  status: string;
  reason: string | null;
  blockNumber: number | null;
  headHeight: number | null;
  finalityHeight: number | null;
  explorerUrl: string | null;
  checkedAt: string;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiUnreachable();
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const body: unknown = text ? safeParse(text) : null;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  createTab(network: 5 | 24): Promise<{ tabId: string; network: number; createdAt: string }> {
    return request('/api/v1/tabs', { method: 'POST', body: JSON.stringify({ network }) });
  },

  getTab(tabId: string): Promise<{ tabId: string; network: number; createdAt: string; entryCount: number; headSeq: string | null }> {
    return request(`/api/v1/tabs/${encodeURIComponent(tabId)}`);
  },

  async getAllEntries(tabId: string, after: string | null = null): Promise<{ rows: StoredEntryRow[]; lastSeq: string | null }> {
    const rows: StoredEntryRow[] = [];
    let cursor = after;
    for (let page = 0; page < 40; page++) {
      const q = cursor === null ? '' : `?after=${encodeURIComponent(cursor)}`;
      const res = await request<{ entries: StoredEntryRow[]; nextAfter: string | null }>(
        `/api/v1/tabs/${encodeURIComponent(tabId)}/entries${q}`,
      );
      rows.push(...res.entries);
      if (res.entries.length > 0) cursor = res.entries[res.entries.length - 1]?.seq ?? cursor;
      if (res.nextAfter === null) break;
    }
    return { rows, lastSeq: cursor };
  },

  appendEntries(tabId: string, entries: LogEntry[]): Promise<AppendResult> {
    return request(`/api/v1/tabs/${encodeURIComponent(tabId)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
  },

  createIntent(body: {
    tabId: string;
    payer: string;
    recipient: string;
    amount: string;
    ref: string;
    network: number;
    idempotencyKey: string;
  }): Promise<ServerIntent> {
    return request('/api/v1/payment-intents', { method: 'POST', body: JSON.stringify(body) });
  },

  submitIntent(intentId: string, txHash: string): Promise<ServerIntent> {
    return request(`/api/v1/payment-intents/${encodeURIComponent(intentId)}/submission`, {
      method: 'POST',
      body: JSON.stringify({ txHash }),
    });
  },

  markIntentUnknown(intentId: string): Promise<ServerIntent> {
    return request(`/api/v1/payment-intents/${encodeURIComponent(intentId)}/unknown`, { method: 'POST', body: '{}' });
  },

  verifyTransaction(tabId: string, txHash: string): Promise<ServerVerification> {
    return request(`/api/v1/transactions/${encodeURIComponent(txHash)}/verification?tabId=${encodeURIComponent(tabId)}`);
  },

  consentedEvent(event: string, installId: string, appVersion: string): Promise<unknown> {
    return request('/api/v1/metrics/consented-event', {
      method: 'POST',
      body: JSON.stringify({ event, installId, appVersion }),
    });
  },
};
