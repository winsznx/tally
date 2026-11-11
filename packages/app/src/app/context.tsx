import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../lib/api.js';
import { RpcChainReader, type ChainReader } from '../lib/chain.js';
import { NETWORK_ID, RPC_URL } from '../lib/config.js';
import { PaymentController } from '../lib/payments.js';
import type { SessionState, SessionStore } from '../lib/session.js';
import { tabStore, type TabSnapshot, type TabStore } from '../lib/tab.js';

interface AppServices {
  session: SessionStore;
  chain: ChainReader;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ session, children }: { session: SessionStore; children: ReactNode }) {
  const value = useMemo(() => ({ session, chain: new RpcChainReader(RPC_URL) }), [session]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}

export function useSession(): SessionState & { store: SessionStore } {
  const { session } = useServices();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { ...state, store: session };
}

function useVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    () => document.visibilityState === 'visible',
  );
}

/** Subscribe to a tab, sync it now, again when the app returns to view, and every 20s while visible. */
export function useTab(tabId: string): { snapshot: TabSnapshot; store: TabStore } {
  const store = useMemo(() => tabStore(tabId), [tabId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const visible = useVisible();
  useEffect(() => {
    if (!visible) return;
    void store.sync();
    const t = setInterval(() => void store.sync(), 20_000);
    return () => clearInterval(t);
  }, [store, visible]);
  return { snapshot, store };
}

const controllers = new Map<string, PaymentController>();

export function usePayments(tabId: string): PaymentController {
  const { session, chain } = useServices();
  const store = useMemo(() => tabStore(tabId), [tabId]);
  let pc = controllers.get(tabId);
  if (!pc) {
    pc = new PaymentController(store, { wallet: session.wallet, chain, api, network: NETWORK_ID });
    controllers.set(tabId, pc);
  }
  return pc;
}

/**
 * Keep checking unresolved payment claims against the chain: quickly while a
 * payment is fresh, slowly after, never while the app is hidden.
 */
export function useVerification(tabId: string, snapshot: TabSnapshot): { chainUnavailable: boolean } {
  const pc = usePayments(tabId);
  const visible = useVisible();
  const unavailable = useRef(false);
  const openCount = snapshot.state.payments.filter((p) => {
    const v = snapshot.verifications.get(p.txHash)?.status;
    return v !== 'confirmed' && v !== 'failed' && v !== 'mismatch';
  }).length;
  useEffect(() => {
    if (!visible || openCount === 0) return;
    let cancelled = false;
    let delay = 4_000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      try {
        const r = await pc.verifyClaims();
        unavailable.current = r.unavailable;
      } catch (e) {
        console.warn('[tally] verification pass failed', e);
      }
      if (cancelled) return;
      delay = Math.min(delay * 1.4, 20_000);
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pc, visible, openCount]);
  return { chainUnavailable: unavailable.current };
}
