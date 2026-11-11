import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { finalityHeight } from '@tally/core/settle';
import { NETWORK_LABEL, explorerTxUrl } from '../../lib/config.js';
import { track } from '../../lib/metrics.js';
import { formatNim } from '../../lib/money.js';
import { nameOf, people } from '../../lib/view.js';
import { Mark } from '../../ui/brand.js';
import { Address, TopBar } from '../../ui/bits.js';
import { Alert, Amount, Button, CopyButton, Empty, Skeleton } from '../../ui/primitives.js';
import { usePayments, useSession, useTab, useVerification } from '../context.js';

/** S10: a receipt that only says "paid" when the chain does. */
export function Receipt() {
  const { tabId = '', txHash = '' } = useParams();
  const s = useSession();
  const { snapshot } = useTab(tabId);
  useVerification(tabId, snapshot);
  const pc = usePayments(tabId);
  const [checking, setChecking] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const me = s.identity?.address ?? '';
  const claim = snapshot.state.payments.find((p) => p.txHash === txHash);
  const v = snapshot.verifications.get(txHash);
  const tracked = useRef(false);
  useEffect(() => {
    if (v?.status === 'confirmed' && claim?.payer === me && !tracked.current) {
      tracked.current = true;
      track('payment_confirmed');
    }
  }, [v?.status, claim?.payer, me]);

  if (!claim) {
    return (
      <div className="screen">
        <TopBar title="Payment" back={`/app/tabs/${tabId}`} />
        {snapshot.state.genesisHash ? (
          <Empty title="No payment with this reference in the tab">
            <p>If it was just sent, it may still be syncing.</p>
          </Empty>
        ) : (
          <Skeleton lines={6} />
        )}
      </div>
    );
  }

  const who = people(snapshot, me);
  const status = v?.status ?? 'pending';
  const paid = status === 'confirmed';
  const problem = status === 'failed' || status === 'mismatch';
  const headline = paid ? 'Paid, confirmed on Nimiq' : problem ? 'Not confirmed' : status === 'observed' ? 'In a block, confirming' : 'Sent, being checked';
  const when = v?.timestamp ? new Date(v.timestamp) : null;
  const text = [
    `Tally receipt: ${snapshot.state.ledgerName ?? 'tab'}`,
    `${nameOf(who, claim.payer, { you: false })} paid ${nameOf(who, claim.recipient, { you: false })} ${formatNim(claim.amount)} NIM`,
    paid ? `Confirmed on ${NETWORK_LABEL}${when ? `, ${when.toLocaleString()}` : ''}` : `Status: ${headline}`,
    explorerTxUrl(txHash),
  ].join('\n');

  async function share(): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Tally receipt', text });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    await navigator.clipboard.writeText(text).then(
      () => setShared('Receipt copied. Paste it into your chat.'),
      () => setShared('Could not copy automatically. Long-press the details to copy them.'),
    );
  }

  return (
    <div className="screen">
      <TopBar title="Receipt" sub={snapshot.state.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />
      <article className={`receipt receipt-${paid ? 'paid' : problem ? 'problem' : 'checking'}`} aria-labelledby="receipt-h">
        <header className="receipt-head">
          <Mark size={28} />
          <p id="receipt-h" className="receipt-status" role="status">
            {headline}
          </p>
        </header>
        <Amount luna={claim.amount} size="xl" />
        <p className="receipt-line">
          {nameOf(who, claim.payer)} to {nameOf(who, claim.recipient)}
        </p>
        <dl className="receipt-details">
          <div>
            <dt>From</dt>
            <dd>
              <Address hex={claim.payer} label="payer address" />
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              <Address hex={claim.recipient} label="recipient address" />
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{claim.network === 24 ? 'Nimiq mainnet' : 'Nimiq testnet'}</dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd className="hash">
              <span className="num">
                {txHash.slice(0, 10)}…{txHash.slice(-8)}
              </span>
              <CopyButton value={txHash} label="Copy transaction hash" />
              <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="linkish">
                Explorer
              </a>
            </dd>
          </div>
          {v?.blockNumber && (
            <div>
              <dt>Block</dt>
              <dd className="num">
                {v.blockNumber.toLocaleString()}
                {!paid && `, final at ${finalityHeight(v.blockNumber).toLocaleString()}`}
              </dd>
            </div>
          )}
          {when && (
            <div>
              <dt>Time</dt>
              <dd>{when.toLocaleString()}</dd>
            </div>
          )}
          <div>
            <dt>Checked</dt>
            <dd>{v ? `${new Date(v.checkedAt).toLocaleTimeString()} by this device, directly on the network` : 'Not yet'}</dd>
          </div>
        </dl>
        {problem && (
          <Alert tone="error" title="This payment does not count">
            {v?.reason ?? 'The network record does not match.'} It is not credited in the tab. If NIM did move, sort it out directly with {nameOf(who, claim.recipient, { you: false })}.
          </Alert>
        )}
        {!paid && !problem && <p className="fineprint">A payment counts once its block is final on the network. That usually takes under a minute.</p>}
      </article>
      <div className="actions-row">
        <Button variant="secondary" onClick={() => void share()}>
          Share receipt
        </Button>
        {!paid && (
          <Button
            variant="quiet"
            busy={checking}
            onClick={() => {
              setChecking(true);
              void pc.verifyClaims().finally(() => setChecking(false));
            }}
          >
            Check now
          </Button>
        )}
      </div>
      {shared && <p className="fineprint pad" role="status">{shared}</p>}
    </div>
  );
}
