import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MAX_NOTE, type ObligationRecord } from '@tally/core/log';
import { track } from '../../lib/metrics.js';
import { formatNim } from '../../lib/money.js';
import { expenseById, nameOf, people } from '../../lib/view.js';
import { TopBar } from '../../ui/bits.js';
import { Alert, Amount, Button, Empty, Pill, Sheet, Skeleton, type PillTone } from '../../ui/primitives.js';
import { useServices, useSession, useTab } from '../context.js';

const STATUS: Record<ObligationRecord['status'], [PillTone, string]> = {
  PROPOSED: ['waiting', 'Waiting for answer'],
  ACCEPTED: ['agreed', 'Agreed'],
  IN_ROUND: ['agreed', 'Agreed'],
  CONTESTED: ['declined', 'Declined'],
  CANCELLED: ['neutral', 'Withdrawn'],
};

const METHOD_COPY = { equal: 'Split equally', exact: 'Split by exact amounts', percent: 'Split by percentage' } as const;

type Pending = { kind: 'accept' | 'decline' | 'withdraw'; ob: ObligationRecord } | null;

/** S07: one expense, its shares, and the decisions on them. */
export function ExpenseDetail() {
  const { tabId = '', expenseId = '' } = useParams();
  const s = useSession();
  const { chain } = useServices();
  const { snapshot, store } = useTab(tabId);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heightRef = useRef<Promise<number | null> | null>(null);
  const me = s.identity?.address ?? '';
  const who = people(snapshot, me);
  const expense = expenseById(snapshot, expenseId);

  if (!expense) {
    return (
      <div className="screen">
        <TopBar title="Expense" back={`/app/tabs/${tabId}`} />
        {snapshot.state.genesisHash ? (
          <Empty title="This expense is not in the tab">
            <p>It may still be syncing from the person who added it.</p>
          </Empty>
        ) : (
          <Skeleton lines={5} />
        )}
      </div>
    );
  }

  const obligations = new Map(snapshot.state.obligations.filter((o) => o.expenseId === expenseId).map((o) => [o.proposeId, o]));
  const payerName = nameOf(who, expense.payer);
  const iPaid = expense.payer === me;

  function openAccept(ob: ObligationRecord): void {
    heightRef.current = chain.headHeight().catch(() => null);
    setPending({ kind: 'accept', ob });
  }

  async function confirm(): Promise<void> {
    if (!pending || !s.identity) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'accept') {
        let height = await (heightRef.current ?? chain.headHeight().catch(() => null));
        height ??= await s.store.wallet.getBlockNumber();
        await store.append(s.identity, 'OBLIGATION_ACCEPT', { proposeId: pending.ob.proposeId, observedHeight: height ?? 1 });
        track('share_accepted');
      } else if (pending.kind === 'decline') {
        await store.append(s.identity, 'OBLIGATION_REJECT', { proposeId: pending.ob.proposeId, ...(reason.trim() ? { reason: reason.trim() } : {}) });
        track('share_declined');
      } else {
        await store.append(s.identity, 'OBLIGATION_CANCEL', { proposeId: pending.ob.proposeId, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      }
      setPending(null);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const sheetTitle = pending?.kind === 'accept' ? 'Agree to your share' : pending?.kind === 'decline' ? 'Decline your share' : pending?.ob.status === 'ACCEPTED' ? 'Forgive this share' : 'Withdraw this request';

  return (
    <div className="screen">
      <TopBar title="Expense" sub={snapshot.state.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />
      <section className="expense-head">
        <p className="muted">{[expense.category, expense.spentOn ? new Date(`${expense.spentOn}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null].filter(Boolean).join(', ')}</p>
        <h1 className="h-page">{expense.title}</h1>
        <Amount luna={expense.total} size="lg" />
        <p className="lede">
          {iPaid ? 'You paid' : `${payerName} paid`}. {METHOD_COPY[expense.method]}.
        </p>
        {expense.note && <p className="note">“{expense.note}”</p>}
      </section>

      <section className="block" aria-labelledby="shares-h">
        <h2 id="shares-h" className="h-block">
          Shares
        </h2>
        <ul className="rows">
          {expense.shares.map((sh) => {
            const ob = sh.proposeId ? obligations.get(sh.proposeId) : undefined;
            const mine = sh.member === me;
            const [tone, label] = ob ? STATUS[ob.status] : (['neutral', 'Paid it'] as [PillTone, string]);
            return (
              <li key={sh.member} className="row row-static">
                <div className="row-main">
                  <p className="row-title">{nameOf(who, sh.member)}</p>
                  <p className="row-sub">{ob ? (ob.status === 'ACCEPTED' || ob.status === 'IN_ROUND' ? `Owes ${payerName === 'You' ? 'you' : payerName}` : ob.status === 'CANCELLED' ? 'No longer owed' : 'Has not agreed yet') : 'Their own share'}</p>
                  {ob && mine && ob.status === 'PROPOSED' && (
                    <div className="row-actions">
                      <Button onClick={() => openAccept(ob)}>Agree to {formatNim(ob.amount)} NIM</Button>
                      <Button variant="ghost" onClick={() => setPending({ kind: 'decline', ob })}>
                        Decline
                      </Button>
                    </div>
                  )}
                  {ob && mine && ob.status === 'CONTESTED' && (
                    <div className="row-actions">
                      <Button variant="secondary" onClick={() => openAccept(ob)}>
                        Agree after all
                      </Button>
                    </div>
                  )}
                  {ob && iPaid && (ob.status === 'PROPOSED' || ob.status === 'CONTESTED' || ob.status === 'ACCEPTED') && (
                    <div className="row-actions">
                      <Button variant="quiet" onClick={() => setPending({ kind: 'withdraw', ob })}>
                        {ob.status === 'ACCEPTED' ? 'Forgive this share' : 'Withdraw request'}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="row-side">
                  <Amount luna={sh.amount} size="md" />
                  <Pill tone={tone}>{label}</Pill>
                </div>
              </li>
            );
          })}
        </ul>
        {expense.shares.some((sh) => sh.proposeId && obligations.get(sh.proposeId)?.status === 'CONTESTED') && (
          <Alert tone="warn" title="A share was declined">
            {iPaid
              ? 'A declined share stays declined unless that person agrees after all. You can withdraw it, or add a corrected expense for them to agree to.'
              : 'The person who paid can withdraw it or ask again with a corrected amount.'}
          </Alert>
        )}
      </section>

      <Sheet
        open={pending !== null}
        title={sheetTitle}
        onClose={() => {
          setPending(null);
          setError(null);
        }}
        footer={
          <>
            <Button block busy={busy} variant={pending?.kind === 'accept' ? 'primary' : pending?.kind === 'decline' ? 'danger' : 'secondary'} onClick={() => void confirm()}>
              {pending?.kind === 'accept' ? 'Yes, I agree' : pending?.kind === 'decline' ? 'Decline share' : pending?.ob.status === 'ACCEPTED' ? 'Forgive share' : 'Withdraw request'}
            </Button>
            <Button block variant="ghost" onClick={() => setPending(null)}>
              Not now
            </Button>
          </>
        }
      >
        {pending?.kind === 'accept' && (
          <p className="sheet-statement">
            You agree you owe <strong>{formatNim(pending.ob.amount)} NIM</strong> to <strong>{nameOf(who, pending.ob.creditor, { you: false })}</strong> for {expense.title}.
          </p>
        )}
        {pending?.kind === 'accept' && <p className="muted">This is signed with your device key and becomes part of the tab’s record. No NIM moves until you choose to pay.</p>}
        {pending && pending.kind !== 'accept' && (
          <>
            <p className="sheet-statement">
              {pending.kind === 'decline'
                ? `You will not owe ${formatNim(pending.ob.amount)} NIM for ${expense.title}. ${payerName} will see that you declined.`
                : `${nameOf(who, pending.ob.debtor, { you: false })} will no longer owe you ${formatNim(pending.ob.amount)} NIM for ${expense.title}.`}
            </p>
            <label className="field-label" htmlFor="reason">
              Reason (optional, visible to the tab)
            </label>
            <textarea id="reason" className="input textarea" rows={2} maxLength={MAX_NOTE} value={reason} onChange={(e) => setReason(e.target.value)} />
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </Sheet>
    </div>
  );
}
