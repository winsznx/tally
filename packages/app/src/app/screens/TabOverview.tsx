import { History as HistoryIcon, Plus, UserPlus } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ObligationRecord } from '@tally/core/log';
import { rememberTab } from '../../lib/registry.js';
import { activity, mySummary, nameOf, people } from '../../lib/view.js';
import { TopBar } from '../../ui/bits.js';
import { Alert, Amount, Button, Empty, Pill, Skeleton } from '../../ui/primitives.js';
import { useSession, useTab, useVerification } from '../context.js';
import { ActivityList } from './History.js';
import { relativeTime } from './Home.js';

export function SyncLine({ sync, pending, lastSyncedAt, onRetry }: { sync: string; pending: number; lastSyncedAt: number | null; onRetry: () => void }) {
  if (pending > 0) {
    return (
      <p className="syncline syncline-warn" role="status">
        {pending} {pending === 1 ? 'change is' : 'changes are'} waiting to sync.{' '}
        <button type="button" className="linkish" onClick={onRetry}>
          Retry now
        </button>
      </p>
    );
  }
  if (sync === 'offline' || sync === 'error') {
    return (
      <p className="syncline syncline-warn" role="status">
        Showing what this device last saw.{' '}
        <button type="button" className="linkish" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  return <p className="syncline">{lastSyncedAt ? `Up to date, ${relativeTime(lastSyncedAt)}` : 'Checking for updates'}</p>;
}

function sumOf(list: ObligationRecord[]): bigint {
  return list.reduce((a, o) => a + o.amount, 0n);
}

/** S05: the tab. */
export function TabOverview() {
  const { tabId = '' } = useParams();
  const s = useSession();
  const nav = useNavigate();
  const { snapshot, store } = useTab(tabId);
  useVerification(tabId, snapshot);
  const me = s.identity?.address ?? '';
  const st = snapshot.state;
  const loaded = st.genesisHash !== null;
  useEffect(() => {
    if (st.ledgerName) rememberTab(tabId, st.ledgerName);
  }, [tabId, st.ledgerName]);

  if (snapshot.sync === 'not_found' && !loaded) {
    return (
      <div className="screen">
        <TopBar title="Tab" back="/app" />
        <Empty title="This tab could not be found">
          <p>Check the invite link with whoever shared it.</p>
        </Empty>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="screen">
        <TopBar title="Loading tab" back="/app" />
        <Skeleton lines={6} />
      </div>
    );
  }
  const memberSelf = st.members.find((m) => m.address === me);
  if (!memberSelf || !memberSelf.active) {
    return (
      <div className="screen">
        <TopBar title={st.ledgerName ?? 'Tab'} back="/app" />
        <Empty title={memberSelf ? 'You left this tab' : 'You are not in this tab yet'} action={<Button onClick={() => nav(`/app/join/${tabId}`)}>{memberSelf ? 'Rejoin' : 'Join'}</Button>}>
          <p>{memberSelf ? 'Your past shares and payments stay on the record.' : 'Join to see where you stand and to add expenses.'}</p>
        </Empty>
      </div>
    );
  }

  const who = people(snapshot, me);
  const sum = mySummary(snapshot, me);
  const awaiting = sumOf(sum.toReview) + sumOf(sum.waitingOnOthers);
  const activeCount = st.members.filter((m) => m.active).length;
  const items = activity(snapshot, me, tabId).slice(0, 6);
  const plan = snapshot.settlement.plan;

  return (
    <div className="screen">
      <TopBar
        title={st.ledgerName ?? 'Tab'}
        sub={`${activeCount} ${activeCount === 1 ? 'person' : 'people'}`}
        back="/app"
        actions={
          <>
            <Link className="icon-btn" to={`/app/tabs/${tabId}/members`} aria-label="Members and invite">
              <UserPlus size={21} strokeWidth={1.9} />
            </Link>
            <Link className="icon-btn" to={`/app/tabs/${tabId}/history`} aria-label="All activity">
              <HistoryIcon size={21} strokeWidth={1.9} />
            </Link>
          </>
        }
      />

      <section className="balance" aria-labelledby="balance-h">
        <h2 id="balance-h" className="balance-label">
          {sum.position < 0n ? 'You owe' : sum.position > 0n ? 'You’re owed' : 'You’re all square'}
        </h2>
        <Amount luna={sum.position < 0n ? -sum.position : sum.position} size="xl" />
        <p className="balance-note">
          {sum.position === 0n ? 'Across every agreed share and every confirmed payment in this tab.' : 'From agreed shares, after confirmed payments.'}
        </p>
        <dl className="balance-parts">
          <div>
            <dt>Awaiting agreement</dt>
            <dd>
              <Amount luna={awaiting} size="sm" />
            </dd>
          </div>
          <div>
            <dt>Ready to settle</dt>
            <dd>
              <Amount luna={sum.legsOut.reduce((a, t) => a + t.amount, 0n)} size="sm" />
            </dd>
          </div>
          <div>
            <dt>Being checked</dt>
            <dd>{sum.paymentsChecking.length === 0 ? <span className="muted">None</span> : <Amount luna={sum.paymentsChecking.reduce((a, p) => a + p.amount, 0n)} size="sm" />}</dd>
          </div>
        </dl>
      </section>

      {snapshot.rejected.length > 0 && (
        <Alert tone="error" title="A change was not accepted" action={<Button variant="secondary" onClick={() => store.dismissRejected()}>Dismiss</Button>}>
          {snapshot.rejected.map((r) => r.reason).join(' ')} It was removed from this device so the tab matches what everyone else sees.
        </Alert>
      )}

      <div className="actions-row">
        {sum.legsOut.length > 0 || sum.legsIn.length > 0 || plan ? (
          <Button onClick={() => nav(`/app/tabs/${tabId}/settle`)} block>
            {sum.legsOut.length > 0 ? 'Settle up' : 'See the settlement plan'}
          </Button>
        ) : null}
        <Button variant={plan ? 'secondary' : 'primary'} block onClick={() => nav(`/app/tabs/${tabId}/expenses/new`)} icon={<Plus size={18} strokeWidth={2.2} />}>
          Add an expense
        </Button>
      </div>

      {activeCount < 2 && (
        <Alert tone="info" title="Invite your group" action={<Button variant="secondary" onClick={() => nav(`/app/tabs/${tabId}/members`)}>Invite</Button>}>
          A tab needs at least two people before anyone can owe anyone.
        </Alert>
      )}

      {sum.toReview.length > 0 && (
        <section className="block" aria-labelledby="review-h">
          <h2 id="review-h" className="h-block">
            Waiting for your answer
          </h2>
          <ul className="rows">
            {sum.toReview.map((o) => (
              <li key={o.proposeId}>
                <Link className="row" to={o.expenseId ? `/app/tabs/${tabId}/expenses/${o.expenseId}` : `/app/tabs/${tabId}/history`}>
                  <div className="row-main">
                    <p className="row-title">{o.memo ?? 'A share'}</p>
                    <p className="row-sub">{nameOf(who, o.creditor)} asks you for your share</p>
                  </div>
                  <div className="row-side">
                    <Amount luna={o.amount} size="md" />
                    <Pill tone="waiting">Review</Pill>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sum.contested.length > 0 && (
        <section className="block" aria-labelledby="contested-h">
          <h2 id="contested-h" className="h-block">
            Declined shares
          </h2>
          <ul className="rows">
            {sum.contested.map((o) => (
              <li key={o.proposeId}>
                <Link className="row" to={o.expenseId ? `/app/tabs/${tabId}/expenses/${o.expenseId}` : `/app/tabs/${tabId}/history`}>
                  <div className="row-main">
                    <p className="row-title">{o.memo ?? 'A share'}</p>
                    <p className="row-sub">
                      {o.debtor === me ? `You declined ${nameOf(who, o.creditor)}’s request` : `${nameOf(who, o.debtor)} declined this`}
                    </p>
                  </div>
                  <div className="row-side">
                    <Amount luna={o.amount} size="md" />
                    <Pill tone="declined">Declined</Pill>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="block" aria-labelledby="activity-h">
        <div className="block-head">
          <h2 id="activity-h" className="h-block">
            Recent activity
          </h2>
          <Link to={`/app/tabs/${tabId}/history`} className="linkish">
            See all
          </Link>
        </div>
        <ActivityList items={items} />
      </section>

      <SyncLine sync={snapshot.sync} pending={snapshot.pending.length} lastSyncedAt={snapshot.lastSyncedAt} onRetry={() => void store.sync()} />
    </div>
  );
}
