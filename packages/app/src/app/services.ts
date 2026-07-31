/**
 * Service wiring: turns build-time config into the adapter instances the flows
 * use. One place constructs everything, so tests can swap in fakes wholesale
 * and nothing else in the app knows where a URL came from.
 */
import { RpcChain } from '../adapters/chain-rpc.js';
import { StoredEntryCache, MemoryStore, type EntryCache } from '../adapters/cache.js';
import { SystemClock } from '../adapters/clock.js';
import { NimiqPayProvider } from '../adapters/provider.js';
import { HttpRelay } from '../adapters/relay.js';
import type { ChainAdapter, ClockAdapter, ProviderAdapter, RelayAdapter } from '../adapters/types.js';
import { RELAY_URL, rpcUrlFor } from '../config.js';

export interface Services {
  provider: ProviderAdapter;
  chain: ChainAdapter;
  relay: RelayAdapter;
  clock: ClockAdapter;
  cache: EntryCache;
  relayUrl: string;
}

export function createServices(networkId: number): Services {
  return {
    provider: new NimiqPayProvider(3000),
    chain: new RpcChain({ url: rpcUrlFor(networkId) }),
    relay: new HttpRelay(RELAY_URL),
    clock: new SystemClock(),
    cache: new StoredEntryCache(safeStorage()),
    relayUrl: RELAY_URL,
  };
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    // localStorage throws in some embedded WebViews with storage disabled.
    window.localStorage.getItem('tally.probe');
    return window.localStorage;
  } catch {
    return new MemoryStore();
  }
}
