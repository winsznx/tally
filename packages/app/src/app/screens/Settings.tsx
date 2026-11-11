import { useState } from 'react';
import { APP_VERSION, NETWORK_LABEL, REPO_URL } from '../../lib/config.js';
import { metricsConsent, setMetricsConsent } from '../../lib/metrics.js';
import { Address, TopBar } from '../../ui/bits.js';
import { Amount, Button } from '../../ui/primitives.js';
import { useSession } from '../context.js';
import { toAddressHex } from '@tally/core/settle';

/** S14: what this device is connected to, privacy, and help. */
export function Settings() {
  const s = useSession();
  const [consent, setConsent] = useState(metricsConsent());
  const htlcHex = s.accounts?.htlcAddress ? safeHex(s.accounts.htlcAddress) : null;
  return (
    <div className="screen">
      <TopBar title="Settings" back="/app" />
      <section className="block" aria-labelledby="wallet-h">
        <h2 id="wallet-h" className="h-block">
          Wallet
        </h2>
        <dl className="kv">
          <div>
            <dt>Network</dt>
            <dd>
              {NETWORK_LABEL}
              {s.caps?.network === 'unknown' && <span className="muted">. Nimiq Pay did not report its network.</span>}
            </dd>
          </div>
          <div>
            <dt>Signed in as</dt>
            <dd>{s.identity ? <Address hex={s.identity.address} label="your account" /> : 'Not signed in'}</dd>
          </div>
          <div>
            <dt>Spending account</dt>
            <dd>
              {htlcHex ? <Address hex={htlcHex} label="spending account" /> : s.accounts ? 'None yet. Top up Nimiq Pay to pay from Tally.' : 'Not loaded'}
              <p className="fineprint">Nimiq Pay keeps spendable NIM in a separate account that it renews about weekly. Tally reads it, never stores it as your identity.</p>
            </dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd>
              {s.balance?.luna != null ? <Amount luna={s.balance.luna} size="sm" /> : <span className="muted">Not loaded</span>}
              {s.balance?.note && <p className="fineprint">{s.balance.note}</p>}
              <div>
                <Button variant="quiet" onClick={() => void (s.accounts ? s.store.refreshBalance() : s.store.loadAccounts())}>
                  {s.accounts ? 'Refresh balance' : 'Load balance'}
                </Button>
              </div>
            </dd>
          </div>
        </dl>
      </section>

      <section className="block" aria-labelledby="device-h">
        <h2 id="device-h" className="h-block">
          This device
        </h2>
        <p className="muted">
          When you signed in, Nimiq Pay signed a message allowing a key on this device to record your agreements in tabs. That key cannot move NIM. Every payment is approved by you in Nimiq Pay.
        </p>
        <Button variant="secondary" onClick={() => s.store.signOutDevice()}>
          Sign out on this device
        </Button>
      </section>

      <section className="block" aria-labelledby="auto-h">
        <h2 id="auto-h" className="h-block">
          Automatic payments
        </h2>
        <p className="muted">
          Not available. An earlier Tally could pay from a small app-held balance without prompts. We switched it off: Nimiq Pay now pays from a co-signed account, and an app-held key is too easy to lose with the phone. Each payment is approved in Nimiq Pay instead.
        </p>
      </section>

      <section className="block" aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="h-block">
          Privacy
        </h2>
        <p className="muted">
          Anyone with a tab’s link can read it. Payments are public on the Nimiq network, like all Nimiq payments. Tally keeps your tab list on this device only.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setMetricsConsent(e.target.checked);
              setConsent(e.target.checked);
            }}
          />
          <span>
            <strong>Share anonymous usage counts</strong>
            <span className="fineprint">Counts like “a payment was confirmed”, with a random device id. No addresses, names, amounts or tab links. Off by default.</span>
          </span>
        </label>
      </section>

      <section className="block" aria-labelledby="help-h">
        <h2 id="help-h" className="h-block">
          Payment trouble
        </h2>
        <ul className="help">
          <li>
            <strong>Stuck on “being checked”.</strong> Tally checks the Nimiq network itself. If the network endpoint is busy, it keeps trying. Your payment is not lost.
          </li>
          <li>
            <strong>“Outcome not confirmed”.</strong> Nimiq Pay did not tell Tally whether it sent. Use “Check the network” on the settle screen. Tally will not let you pay again until it knows.
          </li>
          <li>
            <strong>Declined by mistake.</strong> Nothing was sent. Open Settle up and pay again.
          </li>
        </ul>
      </section>

      <footer className="settings-foot">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="linkish">
          Source code (MIT)
        </a>
        <span className="muted">Version {APP_VERSION}</span>
      </footer>
    </div>
  );
}

function safeHex(address: string): string | null {
  try {
    return toAddressHex(address);
  } catch {
    return null;
  }
}
