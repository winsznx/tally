import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { MAX_DISPLAY_NAME, MAX_NOTE } from '@tally/core/log';
import { ApiUnreachable, api } from '../../lib/api.js';
import { NETWORK_ID } from '../../lib/config.js';
import { track } from '../../lib/metrics.js';
import { preferredDisplayName, rememberTab, setPreferredDisplayName } from '../../lib/registry.js';
import { tabStore } from '../../lib/tab.js';
import { TopBar } from '../../ui/bits.js';
import { Alert, Button, Field, TextInput } from '../../ui/primitives.js';
import { useSession } from '../context.js';

/** S03: start a tab. */
export function NewTab() {
  const s = useSession();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [displayName, setDisplayName] = useState(preferredDisplayName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const nameError = touched && name.trim().length === 0 ? 'Give the tab a name people will recognise.' : null;
  const youError = touched && displayName.trim().length === 0 ? 'Add the name your group knows you by.' : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setTouched(true);
    if (!s.identity || !name.trim() || !displayName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { tabId } = await api.createTab(NETWORK_ID);
      const store = tabStore(tabId);
      await store.open(s.identity, {
        name: name.trim(),
        displayName: displayName.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setPreferredDisplayName(displayName.trim());
      rememberTab(tabId, name.trim());
      track('tab_created');
      nav(`/app/tabs/${tabId}/members?created=1`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiUnreachable ? 'Tally’s server is not reachable right now, so the tab could not be created. Try again in a moment.' : err instanceof Error ? err.message : 'The tab could not be created.');
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <TopBar title="New tab" back="/app" />
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Tab name" htmlFor="tab-name" error={nameError} hint="For example: Lisbon trip, Flat 4B, Thursday football">
          <TextInput id="tab-name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} invalid={Boolean(nameError)} />
        </Field>
        <Field label="What is it for?" htmlFor="tab-desc" hint="Optional. Members see this when they open the invite.">
          <textarea id="tab-desc" className="input textarea" value={description} maxLength={MAX_NOTE} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Your name in this tab" htmlFor="tab-you" error={youError} hint="Shown to the people in this tab. It does not prove who you are; your wallet signature does.">
          <TextInput id="tab-you" value={displayName} maxLength={MAX_DISPLAY_NAME} autoComplete="nickname" onChange={(e) => setDisplayName(e.target.value)} invalid={Boolean(youError)} />
        </Field>
        <Alert tone="info" title="Who can see a tab">
          Anyone with the tab’s link can read its members, expenses and payments. Share it only with the people in the tab.
        </Alert>
        {error && <Alert tone="error" title="Not created">{error}</Alert>}
        <div className="form-actions">
          <Button type="submit" block busy={busy}>
            Create tab
          </Button>
        </div>
      </form>
    </div>
  );
}
