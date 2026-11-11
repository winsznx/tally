import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { appOrigin, nimiqPayDeeplink } from '../../lib/config.js';
import { Mark, Wordmark } from '../../ui/brand.js';
import { QrCode } from '../../ui/bits.js';
import { Alert, Button } from '../../ui/primitives.js';
import { useSession } from '../context.js';

export function Booting() {
  return (
    <div className="boot" aria-busy="true">
      <Mark size={40} title="Tally is starting" />
      <p className="boot-text">Connecting to Nimiq Pay</p>
    </div>
  );
}

function inviteTabId(pathname: string): string | null {
  const m = /^\/app\/join\/([a-z2-7]{26})/.exec(pathname);
  return m ? (m[1] as string) : null;
}

/** S01 inside Nimiq Pay, before sign-in. */
export function Welcome() {
  const s = useSession();
  const { pathname } = useLocation();
  const invited = inviteTabId(pathname) !== null;
  const busy = s.status === 'connecting' || s.status === 'signing';
  return (
    <div className="welcome">
      <div className="welcome-top">
        <Wordmark height={30} />
      </div>
      <div className="welcome-body">
        <h1 className="welcome-title">{invited ? 'You have been invited to a tab' : 'Split it, agree on it, settle it in NIM.'}</h1>
        <p className="welcome-lede">
          {invited
            ? 'Sign in with Nimiq Pay to see the tab and join it.'
            : 'Tally keeps a running tab for your group. Each share is agreed by the person who owes it, and each payment is checked on the Nimiq network before it counts.'}
        </p>
        <ol className="welcome-steps">
          <li>
            <strong>Share your account.</strong> Nimiq Pay asks once so Tally knows your address.
          </li>
          <li>
            <strong>Sign in.</strong> One signature lets this device record your agreements. It cannot move or spend NIM.
          </li>
        </ol>
        {s.error && (
          <Alert tone={s.error.startsWith('You cancelled') ? 'info' : 'error'} title={s.error.startsWith('You cancelled') ? 'Not signed in' : 'Sign-in did not finish'}>
            {s.error}
          </Alert>
        )}
      </div>
      <div className="welcome-foot">
        <Button block busy={busy} onClick={() => void s.store.signIn()}>
          {s.status === 'connecting' ? 'Waiting for Nimiq Pay' : s.status === 'signing' ? 'Confirm the signature in Nimiq Pay' : 'Sign in with Nimiq Pay'}
        </Button>
        <p className="fineprint">Every payment you make later is approved by you in Nimiq Pay, one at a time.</p>
      </div>
    </div>
  );
}

/** S01 outside Nimiq Pay: say so plainly and hand the person to the wallet. */
export function OutsideHost() {
  const { pathname } = useLocation();
  const tabId = inviteTabId(pathname);
  const target = useMemo(() => (tabId ? `${appOrigin()}/l/${tabId}` : `${appOrigin()}/app`), [tabId]);
  const openUrl = nimiqPayDeeplink(target);
  return (
    <div className="outside">
      <a href="/" className="outside-brand" aria-label="Tally home">
        <Wordmark height={28} />
      </a>
      <div className="outside-card">
        <h1>{tabId ? 'Open this tab in Nimiq Pay' : 'Tally runs inside Nimiq Pay'}</h1>
        <p>
          {tabId
            ? 'Someone shared a Tally tab with you. Tabs, agreements and payments all happen in the Nimiq Pay app, where your wallet is.'
            : 'Your wallet lives in the Nimiq Pay app, so that is where Tally signs and pays. This browser is not connected to any wallet.'}
        </p>
        <div className="outside-actions">
          <a className="btn btn-primary btn-block" href={openUrl}>
            <span>Open in Nimiq Pay</span>
          </a>
          <a className="btn btn-secondary btn-block" href="https://nimiq.com/nimiq-pay/" target="_blank" rel="noreferrer">
            <span>Get Nimiq Pay</span>
          </a>
        </div>
        <div className="outside-qr">
          <QrCode value={openUrl} label="QR code that opens this in Nimiq Pay" size={168} />
          <p>On a computer? Scan this with your phone.</p>
        </div>
      </div>
    </div>
  );
}
