import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { isInsideNimiqPay } from './lib/wallet/nimiq-pay.js';
import './styles/tokens.css';

const Landing = lazy(() => import('./landing/Landing.js'));
const AppRoot = lazy(() => import('./app/AppRoot.js'));

function InviteLink() {
  const { tabId = '' } = useParams();
  return <Navigate to={`/app/join/${tabId}`} replace />;
}

function Home() {
  const { search } = useLocation();
  if (isInsideNimiqPay()) return <Navigate to={`/app${search}`} replace />;
  return <Landing />;
}

function Loading() {
  return <div className="boot" aria-busy="true" aria-label="Loading Tally" />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/l/:tabId" element={<InviteLink />} />
          <Route path="/app/*" element={<AppRoot />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
