import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatNim } from '../../lib/money.js';
import { activity, type ActivityItem } from '../../lib/view.js';
import { TopBar } from '../../ui/bits.js';
import { Amount, Button, Empty, Pill, Segmented, type PillTone } from '../../ui/primitives.js';
import { useSession, useTab, useVerification } from '../context.js';
import { relativeTime } from './Home.js';

const STATUS_LABEL: Partial<Record<ActivityItem['status'], [PillTone, string]>> = {
  agreed: ['agreed', 'Agreed'],
  waiting: ['waiting', 'Waiting'],
  declined: ['declined', 'Declined'],
  paid: ['paid', 'Paid'],
  checking: ['checking', 'Checking'],
  problem: ['problem', 'Not confirmed'],
};

export function ActivityList({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return <p className="muted pad">Nothing has happened in this tab yet.</p>;
  return (
    <ul className="rows activity">
      {items.map((it) => {
        const status = STATUS_LABEL[it.status];
        const body = (
          <>
            <div className="row-main">
              <p className="row-title">{it.text}</p>
              <p className="row-sub">
                {it.pending ? 'Waiting to sync' : it.at ? relativeTime(it.at) : 'Time not recorded'}
                {it.detail ? `. ${it.detail}` : ''}
              </p>
            </div>
            <div className="row-side">
              {it.amount !== null && <Amount luna={it.amount} size="sm" />}
              {status && <Pill tone={status[0]}>{status[1]}</Pill>}
            </div>
            {it.link && <ChevronRight className="row-chevron" size={18} strokeWidth={1.9} aria-hidden />}
          </>
        );
        return <li key={it.id}>{it.link ? <Link className="row" to={it.link}>{body}</Link> : <div className="row">{body}</div>}</li>;
      })}
    </ul>
  );
}

type Filter = 'all' | 'requests' | 'payments' | 'disputed';

function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** S11: everything that happened, readable first, exportable second. */
export function History() {
  const { tabId = '' } = useParams();
  const s = useSession();
  const { snapshot } = useTab(tabId);
  useVerification(tabId, snapshot);
  const [filter, setFilter] = useState<Filter>('all');
  const all = activity(snapshot, s.identity?.address ?? null, tabId);
  const items = all.filter((it) => {
    if (filter === 'requests') return it.kind === 'expense' || it.kind === 'request' || it.kind === 'accept' || it.kind === 'cancel';
    if (filter === 'payments') return it.kind === 'payment';
    if (filter === 'disputed') return it.kind === 'decline' || it.status === 'problem';
    return true;
  });
  const name = (snapshot.state.ledgerName ?? 'tab').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  return (
    <div className="screen">
      <TopBar title="Activity" sub={snapshot.state.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />
      <Segmented
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'requests', label: 'Requests' },
          { value: 'payments', label: 'Payments' },
          { value: 'disputed', label: 'Disputed' },
        ]}
      />
      {items.length === 0 ? <Empty title="Nothing here yet" /> : <ActivityList items={items} />}
      <section className="block export" aria-labelledby="export-h">
        <h2 id="export-h" className="h-block">
          Export
        </h2>
        <p className="muted">Exports contain every name, amount and address in this tab. Share them only with its members.</p>
        <div className="actions-row">
          <Button
            variant="secondary"
            onClick={() =>
              download(
                `${name}-activity.csv`,
                'text/csv',
                ['when,what,amount_nim,status', ...all.map((it) => [it.at ? new Date(it.at).toISOString() : '', it.text, it.amount === null ? '' : formatNim(it.amount).replace(/,/g, ''), it.status].map(csvCell).join(','))].join('\n'),
              )
            }
          >
            Download CSV
          </Button>
          <Button
            variant="quiet"
            onClick={() => download(`${name}-signed-log.json`, 'application/json', JSON.stringify({ tabId, entries: snapshot.entries }, null, 2))}
          >
            Download signed log
          </Button>
        </div>
        <p className="fineprint">The signed log lets anyone re-check every agreement against its signature, without Tally.</p>
      </section>
    </div>
  );
}
