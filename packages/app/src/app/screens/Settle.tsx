import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Transfer } from '@tally/core/netting';
import { NETWORK_LABEL } from '../../lib/config.js';
import { friendlyAddress } from '../../lib/identity.js';
import { track } from '../../lib/metrics.js';
import { formatNim } from '../../lib/money.js';
import { PaymentBlocked, paymentStatus, type LocalIntent, type PaymentStatus } from '../../lib/payments.js';
import { mySummary, nameOf, people } from '../../lib/view.js';
import { Timeline, TopBar, type TimelineStep } from '../../ui/bits.js';
import { Alert, Amount, Button, Empty, Sheet, Skeleton } from '../../ui/primitives.js';
import { usePayments, useSession, useTab, useVerification } from '../context.js';

export function paymentSteps(status: PaymentStatus, message: string | null): TimelineStep[] {
  const order: PaymentStatus[] = ['awaiting_user_approval', 'submitted', 'observed_unconfirmed', 'confirmed'];
  const labels = ['Approve in Nimiq Pay', 'Sent to the network', 'Seen in a block', 'Confirmed on Nimiq'];
  if (status === 'declined') return [{ label: 'You declined in Nimiq Pay', detail: 'Nothing was sent. You can pay whenever you are ready.', state: 'problem' }];
  if (status === 'unknown') {
    return [
      { label: 'Approve in Nimiq Pay', state: 'done' },
      { label: 'Outcome not confirmed', detail: message ?? 'Tally is checking the network before anything else happens.', state: 'problem' },
    ];
  }
  if (status === 'failed') return [{ label: 'Not paid', detail: message ?? 'The network record does not match this payment.', state: 'problem' }];
  const at = order.indexOf(status);
  return labels.map((label, i) => ({
    label,
    state: i < at || status === 'confirmed' ? 'done' : i === at ? 'current' : 'todo',
    detail:
      i === at && status === 'submitted'
        ? 'Nimiq Pay sent it. Checking the network for it now.'
        : i === at && status === 'observed_unconfirmed'
          ? 'In a block. Waiting for the next checkpoint, usually under a minute.'
          : undefined,
  }));
}

/** S08 + S09: the plan, your part of it, and paying it. */
export function Settle() {
  const { tabId = '' } = useParams();
  const s = useSession();
  const { snapshot } = useTab(tabId);
  const { chainUnavailable } = useVerification(tabId, snapshot);
  const pc = usePayments(tabId);
  const [leg, setLeg] = useState<Transfer | null>(null);
  const [intent, setIntent] = useState<LocalIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const me = s.identity?.address ?? '';
  const st = snapshot.state;

  useEffect(() => {
    if (leg && !s.accounts) void s.store.loadAccounts();
  }, [leg, s.accounts, s.store]);

  if (!st.genesisHash) {
    return (
      <div className="screen">
        <TopBar title="Settle up" back={`/app/tabs/${tabId}`} />
        <Skeleton lines={6} />
      </div>
    );
  }

  const who = people(snapshot, me);
  const sum = mySummary(snapshot, me);
  const plan = snapshot.settlement.plan;
  const unagreed = st.obligations.filter((o) => o.status === 'PROPOSED' || o.status === 'CONTESTED').length;
  const blocking = pc.blockingPayment(me);
  const blockingIntent = blocking?.intent ?? null;
  const blockingClaim = blocking?.claim ?? null;
  const liveIntent = intent ? (pc.intents.find((x) => x.id === intent.id) ?? intent) : null;
  const liveStatus = liveIntent ? paymentStatus(liveIntent, liveIntent.txHash ? (snapshot.verifications.get(liveIntent.txHash)?.status ?? null) : null) : null;
  const paymentsDisabled = s.networkMismatch || s.accountMismatch || s.isPreview;

  async function pay(): Promise<void> {
    if (!leg || !s.identity) return;
    setBusy(true);
    setError(null);
    track('payment_started');
    try {
      const result = await pc.pay(s.identity, leg.to, leg.amount);
      setIntent(result);
      if (result.phase === 'submitted') track('payment_submitted');
      if (result.phase === 'declined') track('payment_declined');
      void s.store.refreshBalance();
    } catch (e) {
      setError(e instanceof PaymentBlocked ? e.message : e instanceof Error ? e.message : 'The payment could not start.');
    } finally {
      setBusy(false);
    }
  }

  async function recheck(id: string): Promise<void> {
    if (!s.identity) return;
    setChecking(true);
    try {
      const r = await pc.reconcile(s.identity, id);
      setIntent(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the network.');
    } finally {
      setChecking(false);
    }
  }

  const closeSheet = (): void => {
    setLeg(null);
    setIntent(null);
    setError(null);
  };

  return (
    <div className="screen">
      <TopBar title="Settle up" sub={st.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />

      {plan === null ? (
        <Empty title="Nobody owes anybody">
          <p>{unagreed > 0 ? `${unagreed} ${unagreed === 1 ? 'share is' : 'shares are'} still waiting to be agreed. They join the plan once agreed.` : 'Add an expense and once shares are agreed, the plan appears here.'}</p>
        </Empty>
      ) : (
        <>
          <section className="reduction" aria-labelledby="reduction-h">
            <h2 id="reduction-h" className="visually-hidden">
              How the plan was reduced
            </h2>
            {snapshot.settlement.openDebtCount > plan.transfers.length ? (
              <div className="reduction-figures">
                <div>
                  <span className="reduction-n num">{snapshot.settlement.openDebtCount}</span>
                  <span className="reduction-l">debts between people</span>
                </div>
                <div className="reduction-arrow" aria-hidden />
                <div>
                  <span className="reduction-n reduction-n-after num">{plan.transfers.length}</span>
                  <span className="reduction-l">{plan.transfers.length === 1 ? 'payment settles them' : 'payments settle them'}</span>
                </div>
              </div>
            ) : (
              <p className="reduction-single">
                <span className="reduction-n reduction-n-after num">{plan.transfers.length}</span>
                <span className="reduction-l">{plan.transfers.length === 1 ? 'payment settles this tab' : 'payments settle this tab'}</span>
              </p>
            )}
            <p className="muted">
              Tally adds up what each person owes and is owed, so debts that go in a circle cancel out. Only agreed shares and confirmed payments count.
              {unagreed > 0 && ` ${unagreed} ${unagreed === 1 ? 'share is' : 'shares are'} still waiting for agreement and not included.`}
            </p>
          </section>

          {(blockingIntent || blockingClaim) && (
            <Alert
              tone={blockingIntent?.phase === 'unknown' ? 'warn' : 'info'}
              title={blockingIntent?.phase === 'unknown' ? 'Your last payment needs checking' : 'Your last payment is being checked'}
              action={
                blockingIntent?.phase === 'unknown' ? (
                  <Button variant="secondary" busy={checking} onClick={() => void recheck(blockingIntent.id)}>
                    Check the network
                  </Button>
                ) : blockingClaim ? (
                  <Link className="btn btn-secondary" to={`/app/tabs/${tabId}/payments/${blockingClaim.txHash}`}>
                    <span>View</span>
                  </Link>
                ) : undefined
              }
            >
              {blockingIntent?.message ??
                `${formatNim(BigInt(blockingClaim?.amount ?? blockingIntent?.amount ?? 0))} NIM to ${nameOf(who, blockingClaim?.recipient ?? blockingIntent?.recipient ?? '')}. New payments wait until the network confirms it, so nothing is paid twice.`}
            </Alert>
          )}

          <section className="block" aria-labelledby="mine-h">
            <h2 id="mine-h" className="h-block">
              Your part
            </h2>
            {sum.legsOut.length === 0 && sum.legsIn.length === 0 && <p className="lede pad">Nothing to pay and nothing coming to you.</p>}
            <ul className="rows">
              {sum.legsOut.map((t) => (
                <li key={`${t.from}-${t.to}`} className="row row-static leg-out">
                  <div className="row-main">
                    <p className="row-title">Pay {nameOf(who, t.to)}</p>
                    <p className="row-sub">Clears what you owe in this tab, as far as it reaches.</p>
                  </div>
                  <div className="row-side">
                    <Amount luna={t.amount} size="md" />
                  </div>
                  <div className="row-cta">
                    <Button
                      block
                      disabled={paymentsDisabled || blocking !== null}
                      onClick={() => {
                        setLeg(t);
                        setIntent(null);
                      }}
                    >
                      Pay {formatNim(t.amount)} NIM
                    </Button>
                  </div>
                </li>
              ))}
              {sum.legsIn.map((t) => (
                <li key={`${t.from}-${t.to}`} className="row row-static">
                  <div className="row-main">
                    <p className="row-title">{nameOf(who, t.from)} pays you</p>
                    <p className="row-sub">They pay from their own Nimiq Pay. You will see it here once confirmed.</p>
                  </div>
                  <div className="row-side">
                    <Amount luna={t.amount} size="md" />
                  </div>
                </li>
              ))}
            </ul>
            {s.isPreview && <p className="fineprint pad">The preview wallet cannot pay. Open Tally in Nimiq Pay.</p>}
          </section>

          {plan.transfers.filter((t) => t.from !== me && t.to !== me).length > 0 && (
            <section className="block" aria-labelledby="others-h">
              <h2 id="others-h" className="h-block">
                Everyone else
              </h2>
              <ul className="rows">
                {plan.transfers
                  .filter((t) => t.from !== me && t.to !== me)
                  .map((t) => (
                    <li key={`${t.from}-${t.to}`} className="row row-static">
                      <div className="row-main">
                        <p className="row-title">
                          {nameOf(who, t.from)} pays {nameOf(who, t.to)}
                        </p>
                      </div>
                      <div className="row-side">
                        <Amount luna={t.amount} size="sm" />
                      </div>
                    </li>
                  ))}
              </ul>
              <p className="fineprint pad">Only each payer can pay their own part, from their own wallet.</p>
            </section>
          )}
        </>
      )}

      {chainUnavailable && <Alert tone="warn">The Nimiq network endpoint is not answering. Payments stay as “being checked” until it does.</Alert>}

      <Sheet open={leg !== null} title={liveIntent ? 'Payment' : 'Review payment'} onClose={closeSheet}>
        {leg && !liveIntent && (
          <>
            <dl className="review">
              <div>
                <dt>To</dt>
                <dd>
                  <strong>{nameOf(who, leg.to, { you: false })}</strong>
                  <span className="review-address num">{friendlyAddress(leg.to)}</span>
                </dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>
                  <Amount luna={leg.amount} size="lg" />
                </dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{NETWORK_LABEL}</dd>
              </div>
              <div>
                <dt>You can spend</dt>
                <dd>
                  {s.balance?.luna != null ? <Amount luna={s.balance.luna} size="sm" /> : <span className="muted">Not available</span>}
                  {s.balance?.note && <span className="review-note">{s.balance.note}</span>}
                </dd>
              </div>
              <div>
                <dt>Public memo</dt>
                <dd className="muted">A short Tally reference, so this payment can be matched to the tab. It shows on the Nimiq explorer.</dd>
              </div>
            </dl>
            {s.balance?.luna != null && s.balance.luna > 0n && s.balance.luna < leg.amount && (
              <Alert tone="warn">This is more than your Nimiq Pay balance shows. Nimiq Pay will refuse it unless you top up.</Alert>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <div className="sheet-actions">
              <Button block busy={busy} onClick={() => void pay()}>
                {busy ? 'Waiting for Nimiq Pay' : `Pay ${formatNim(leg.amount)} NIM`}
              </Button>
              <Button block variant="ghost" onClick={closeSheet}>
                Not now
              </Button>
              <p className="fineprint">Nimiq Pay shows the same recipient and amount and asks you to approve. Closing this does not send anything.</p>
            </div>
          </>
        )}
        {liveIntent && liveStatus && (
          <>
            <p className="sheet-statement">
              {formatNim(BigInt(liveIntent.amount))} NIM to {nameOf(who, liveIntent.recipient, { you: false })}
            </p>
            <Timeline steps={paymentSteps(liveStatus, liveIntent.message)} />
            {liveStatus === 'unknown' && (
              <Button block variant="secondary" busy={checking} onClick={() => void recheck(liveIntent.id)}>
                Check the network
              </Button>
            )}
            {liveIntent.txHash && (
              <Link className="btn btn-secondary btn-block" to={`/app/tabs/${tabId}/payments/${liveIntent.txHash}`}>
                <span>{liveStatus === 'confirmed' ? 'View receipt' : 'Track this payment'}</span>
              </Link>
            )}
            {liveStatus === 'declined' && (
              <Button block onClick={() => setIntent(null)}>
                Review again
              </Button>
            )}
            <Button block variant="ghost" onClick={closeSheet}>
              Close
            </Button>
          </>
        )}
      </Sheet>
    </div>
  );
}
