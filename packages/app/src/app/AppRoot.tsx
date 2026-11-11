import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { NETWORK_LABEL } from '../lib/config.js';
import { track } from '../lib/metrics.js';
import { SessionStore, createWallet } from '../lib/session.js';
import { storageIsPersistent } from '../lib/storage.js';
import { Alert, Button } from '../ui/primitives.js';
import '../styles/app.css';
import { ServicesProvider, useSession } from './context.js';
import { AddExpense } from './screens/AddExpense.js';
import { ExpenseDetail } from './screens/ExpenseDetail.js';
import { History } from './screens/History.js';
import { Home } from './screens/Home.js';
import { Join } from './screens/Join.js';
import { Members } from './screens/Members.js';
import { NewTab } from './screens/NewTab.js';
import { Receipt } from './screens/Receipt.js';
import { Settings } from './screens/Settings.js';
import { Settle } from './screens/Settle.js';
import { TabOverview } from './screens/TabOverview.js';
import { Booting, OutsideHost, Welcome } from './screens/Welcome.js';
import { ErrorBoundary } from './ErrorBoundary.js';

export default function AppRoot() {
  const [session, setSession] = useState<SessionStore | null>(null);
  useEffect(() => {
    let alive = true;
    void createWallet().then(async ({ wallet, isPreview }) => {
      const store = new SessionStore(wallet, isPreview);
      if (!alive) return;
      setSession(store);
      await store.boot();
      track('app_opened');
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!session) return <Booting />;
  return (
    <ServicesProvider session={session}>
      <ErrorBoundary>
        <Gate />
      </ErrorBoundary>
    </ServicesProvider>
  );
}

function Banners() {
  const s = useSession();
  return (
    <div className="banners">
      {s.isPreview && (
        <div className="preview-ribbon" role="note">
          Preview wallet for development. It can sign but cannot send NIM.
        </div>
      )}
      {s.networkMismatch && (
        <Alert tone="error" title={`Nimiq Pay is not on ${NETWORK_LABEL}`}>
          This Tally runs on {NETWORK_LABEL}. Payments are switched off until Nimiq Pay uses the same network.
        </Alert>
      )}
      {s.accountMismatch && (
        <Alert
          tone="warn"
          title="Nimiq Pay switched accounts"
          action={
            <Button variant="secondary" onClick={() => s.store.signOutDevice()}>
              Sign in again
            </Button>
          }
        >
          You are signed in to Tally as a different account than the one Nimiq Pay now uses. Nothing will be signed or paid from the new account until you sign in with it.
        </Alert>
      )}
      {!storageIsPersistent() && (
        <Alert tone="warn" title="This device is not saving Tally data">
          Storage is turned off in this browser, so your sign-in and tab list last only until you close Tally.
        </Alert>
      )}
    </div>
  );
}

function Gate() {
  const s = useSession();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  if (s.status === 'booting') return <Booting />;
  if (s.status === 'outside') return <OutsideHost />;
  if (!s.identity) return <Welcome />;
  return (
    <div className="app">
      <Banners />
      <main className="app-main">
        <Routes>
          <Route index element={<Home />} />
          <Route path="tabs/new" element={<NewTab />} />
          <Route path="join/:tabId" element={<Join />} />
          <Route path="tabs/:tabId" element={<TabOverview />} />
          <Route path="tabs/:tabId/expenses/new" element={<AddExpense />} />
          <Route path="tabs/:tabId/expenses/:expenseId" element={<ExpenseDetail />} />
          <Route path="tabs/:tabId/settle" element={<Settle />} />
          <Route path="tabs/:tabId/payments/:txHash" element={<Receipt />} />
          <Route path="tabs/:tabId/members" element={<Members />} />
          <Route path="tabs/:tabId/history" element={<History />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
    </div>
  );
}
