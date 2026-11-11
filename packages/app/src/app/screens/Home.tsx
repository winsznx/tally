import { Plus, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { knownTabs, type KnownTab } from '../../lib/registry.js';
import { tabStore } from '../../lib/tab.js';
import { mySummary } from '../../lib/view.js';
import { Mark, Wordmark } from '../../ui/brand.js';
import { Amount, Button, Empty, Pill } from '../../ui/primitives.js';
import { useSession } from '../context.js';

function TabRow({ tab, me }: { tab: KnownTab; me: string }) {
  const store = useMemo(() => tabStore(tab.tabId), [tab.tabId]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.sync();
  }, [store]);
  const loaded = snap.state.genesisHash !== null;
  const sum = loaded ? mySummary(snap, me) : null;
  const memberCount = snap.state.members.filter((m) => m.active).length;
  const lastAt = Math.max(0, ...snap.receivedAt.values());
  return (
    <li>
      <Link className="tab-row" to={`/app/tabs/${tab.tabId}`}>
        <div className="tab-row-main">
          <p className="tab-row-name">{snap.state.ledgerName ?? tab.name}</p>
          <p className="tab-row-meta">
            {loaded ? `${memberCount} ${memberCount === 1 ? 'person' : 'people'}` : snap.sync === 'not_found' ? 'Not found' : 'Loading'}
            {lastAt > 0 && <> · last activity {relativeTime(lastAt)}</>}
          </p>
          {sum && sum.toReview.length > 0 && (
            <p className="tab-row-flag">
              <Pill tone="waiting">
                {sum.toReview.length} {sum.toReview.length === 1 ? 'request' : 'requests'} for you
              </Pill>
            </p>
          )}
        </div>
        <div className="tab-row-side">
          {sum && sum.position !== 0n ? (
            <>
              <span className="tab-row-label">{sum.position < 0n ? 'You owe' : 'You’re owed'}</span>
              <Amount luna={sum.position < 0n ? -sum.position : sum.position} size="md" />
            </>
          ) : sum ? (
            <span className="tab-row-label">All square</span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** S02: your tabs. */
export function Home() {
  const s = useSession();
  const nav = useNavigate();
  const tabs = knownTabs();
  const me = s.identity?.address ?? '';
  return (
    <div className="screen">
      <header className="home-head">
        <Wordmark height={26} />
        <Link className="icon-btn" to="/app/settings" aria-label="Settings">
          <SettingsIcon size={22} strokeWidth={1.9} />
        </Link>
      </header>
      {tabs.length === 0 ? (
        <Empty
          art={<Mark size={56} />}
          title="Start a tab for your group"
          action={
            <Button onClick={() => nav('/app/tabs/new')} icon={<Plus size={18} strokeWidth={2.2} />}>
              Start a tab
            </Button>
          }
        >
          <p>A tab is one shared list of what everyone paid and owes, for a trip, a flat or a weekly dinner. Got an invite link? Open it in Nimiq Pay to join.</p>
        </Empty>
      ) : (
        <>
          <div className="section-head">
            <h1 className="h-page">Your tabs</h1>
            <Button variant="secondary" onClick={() => nav('/app/tabs/new')} icon={<Plus size={18} strokeWidth={2.2} />}>
              New tab
            </Button>
          </div>
          <ul className="tab-list">
            {tabs.map((t) => (
              <TabRow key={t.tabId} tab={t} me={me} />
            ))}
          </ul>
          <p className="fineprint pad">Tabs you open on this device are listed here. On a new device, open the tab’s invite link again.</p>
        </>
      )}
    </div>
  );
}
