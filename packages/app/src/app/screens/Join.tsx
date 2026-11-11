import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { MAX_DISPLAY_NAME } from '@tally/core/log';
import { track } from '../../lib/metrics.js';
import { TAB_ID_RE, preferredDisplayName, rememberTab, setPreferredDisplayName } from '../../lib/registry.js';
import { people } from '../../lib/view.js';
import { Address, TopBar } from '../../ui/bits.js';
import { Alert, Button, Empty, Field, Skeleton, TextInput } from '../../ui/primitives.js';
import { useSession, useTab } from '../context.js';

/** S04: open an invite and join. */
export function Join() {
  const { tabId = '' } = useParams();
  if (!TAB_ID_RE.test(tabId)) {
    return (
      <div className="screen">
        <TopBar title="Invite" back="/app" />
        <Empty title="This invite link is incomplete">
          <p>Ask for the link again. A Tally invite ends in a 26-character code.</p>
        </Empty>
      </div>
    );
  }
  return <JoinValid tabId={tabId} />;
}

function JoinValid({ tabId }: { tabId: string }) {
  const s = useSession();
  const nav = useNavigate();
  const { snapshot, store } = useTab(tabId);
  const [displayName, setDisplayName] = useState(preferredDisplayName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = s.identity?.address ?? '';
  const st = snapshot.state;

  if (st.members.some((m) => m.address === me && m.active)) {
    rememberTab(tabId, st.ledgerName ?? 'Tab');
    return <Navigate to={`/app/tabs/${tabId}`} replace />;
  }
  if (snapshot.sync === 'not_found') {
    return (
      <div className="screen">
        <TopBar title="Invite" back="/app" />
        <Empty title="No tab at this link">
          <p>The tab may have been created on a different Tally, or the link was cut short. Ask for it again.</p>
        </Empty>
      </div>
    );
  }
  if (!st.genesisHash) {
    return (
      <div className="screen">
        <TopBar title="Invite" back="/app" />
        {snapshot.sync === 'offline' || snapshot.sync === 'error' ? (
          <Alert tone="error" title="Could not load the tab" action={<Button variant="secondary" onClick={() => void store.sync()}>Try again</Button>}>
            {snapshot.syncError}
          </Alert>
        ) : (
          <Skeleton lines={5} />
        )}
      </div>
    );
  }

  const who = people(snapshot, me);
  const active = st.members.filter((m) => m.active);
  async function join(): Promise<void> {
    if (!s.identity || !displayName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await store.append(s.identity, 'MEMBER_JOIN', { displayName: displayName.trim() });
      setPreferredDisplayName(displayName.trim());
      rememberTab(tabId, st.ledgerName ?? 'Tab');
      track('tab_joined');
      nav(`/app/tabs/${tabId}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <TopBar title="Join tab" back="/app" />
      <section className="join-hero">
        <h1 className="h-page">{st.ledgerName}</h1>
        {st.description && <p className="lede">{st.description}</p>}
        <p className="muted">
          {active.length} {active.length === 1 ? 'person' : 'people'}: {active.map((m) => who.get(m.address)?.name).join(', ')}
        </p>
      </section>
      <div className="form">
        <Field label="Your name in this tab" htmlFor="join-name" hint="What the group sees next to your shares and payments.">
          <TextInput id="join-name" value={displayName} maxLength={MAX_DISPLAY_NAME} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <div className="disclosure">
          <p className="disclosure-title">Joining as</p>
          <Address hex={me} label="your account" />
          <p className="fineprint">
            Joining publishes your account address and the device key you signed in with, so members can check your agreements are really yours. It does not prove your name, and it gives no one access to your NIM.
          </p>
        </div>
        <Alert tone="info">Anyone with this link can read the tab, including amounts and names.</Alert>
        {snapshot.sync === 'offline' && <Alert tone="warn">You are offline. Your join will be sent when the connection is back.</Alert>}
        {error && <Alert tone="error" title="Could not join">{error}</Alert>}
        <div className="form-actions">
          <Button block busy={busy} disabled={!displayName.trim()} onClick={() => void join()}>
            Join {st.ledgerName}
          </Button>
        </div>
      </div>
    </div>
  );
}
