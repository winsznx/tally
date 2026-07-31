import { describe, expect, it } from 'vitest';
import { HttpRelay } from './relay.js';

describe('the default fetch is invoked with the correct receiver', () => {
  it('does not call fetch with the adapter as `this` (browser Illegal invocation)', async () => {
    // Browsers throw when `fetch` runs with a receiver that is not the global.
    // Node does not, which is exactly why this shipped once: every other test
    // injects a fake fetch and never exercises the default path.
    const realFetch = globalThis.fetch;
    let sawWrongReceiver = false;
    globalThis.fetch = function (this: unknown, _url: string | URL | Request) {
      if (this !== undefined && this !== globalThis) {
        sawWrongReceiver = true;
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    } as typeof globalThis.fetch;

    try {
      const relay = new HttpRelay('https://relay.example'); // no injected fetch: the real path
      await expect(relay.getSince('abc', null)).resolves.toEqual([]);
      expect(sawWrongReceiver).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
