import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MAX_NOTE, MAX_TITLE, entryId } from '@tally/core/log';
import { track } from '../../lib/metrics.js';
import { PARSE_ERROR_COPY, formatNim, parseNim } from '../../lib/money.js';
import { parsePercent, splitEqual, splitExact, splitPercent, type SplitMethod, type SplitResult } from '../../lib/split.js';
import { nameOf, people } from '../../lib/view.js';
import { TopBar } from '../../ui/bits.js';
import { Alert, Amount, Button, Field, Segmented, TextInput } from '../../ui/primitives.js';
import { useSession, useTab } from '../context.js';

const CATEGORIES = ['Food', 'Drinks', 'Transport', 'Stay', 'Groceries', 'Tickets', 'Home', 'Other'];

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** S06: record something you paid for the group. */
export function AddExpense() {
  const { tabId = '' } = useParams();
  const s = useSession();
  const nav = useNavigate();
  const { snapshot, store } = useTab(tabId);
  const me = s.identity?.address ?? '';
  const who = people(snapshot, me);
  const active = snapshot.state.members.filter((m) => m.active).map((m) => m.address);

  const [title, setTitle] = useState('');
  const [amountText, setAmountText] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [spentOn, setSpentOn] = useState(today());
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<SplitMethod>('equal');
  const [included, setIncluded] = useState<Set<string>>(() => new Set(active));
  const [exact, setExact] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseNim(amountText);
  const total = parsed.ok ? parsed.luna : 0n;
  const members = active.filter((a) => included.has(a));

  const split: SplitResult = (() => {
    if (!parsed.ok) return { ok: false, error: 'Enter the total first.' };
    if (method === 'equal') return splitEqual(total, members);
    if (method === 'exact') {
      const map = new Map<string, bigint>();
      for (const m of members) {
        const r = parseNim(exact[m] ?? '');
        if (r.ok) map.set(m, r.luna);
        else if ((exact[m] ?? '').trim() !== '') return { ok: false, error: `${nameOf(who, m)}: ${PARSE_ERROR_COPY[r.error]}` };
      }
      return splitExact(total, map);
    }
    const map = new Map<string, number>();
    for (const m of members) {
      const raw = (percent[m] ?? '').trim();
      if (raw === '') continue;
      const bp = parsePercent(raw);
      if (bp === null) return { ok: false, error: `${nameOf(who, m)}: use a percentage like 25 or 12.5.` };
      map.set(m, bp);
    }
    return splitPercent(total, map);
  })();

  const owedByOthers = split.ok ? split.shares.filter((sh) => sh.member !== me) : [];
  const titleError = touched && !title.trim() ? 'Say what it was for.' : null;
  const amountError = touched && !parsed.ok ? PARSE_ERROR_COPY[parsed.error] : null;
  const splitError = touched && parsed.ok && !split.ok ? split.error : null;
  const nobodyElse = touched && split.ok && owedByOthers.length === 0 ? 'Include at least one other person, otherwise nobody owes anything.' : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setTouched(true);
    if (!s.identity || !title.trim() || !parsed.ok || !split.ok || owedByOthers.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await store.append(s.identity, 'EXPENSE_RECORD', {
        title: title.trim(),
        total: total.toString(),
        method,
        shares: split.shares.map((sh) => ({ member: sh.member, amount: sh.amount.toString() })),
        ...(category ? { category } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(spentOn ? { spentOn } : {}),
      });
      track('expense_recorded');
      nav(`/app/tabs/${tabId}/expenses/${entryId(entry)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The expense could not be saved.');
      setBusy(false);
    }
  }

  const toggle = (m: string): void => {
    const next = new Set(included);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    setIncluded(next);
  };

  return (
    <div className="screen">
      <TopBar title="Add an expense" sub={snapshot.state.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="What was it?" htmlFor="x-title" error={titleError}>
          <TextInput id="x-title" value={title} maxLength={MAX_TITLE} placeholder="Dinner at Taberna" onChange={(e) => setTitle(e.target.value)} invalid={Boolean(titleError)} />
        </Field>
        <Field label="Total you paid, in NIM" htmlFor="x-amount" error={amountError} hint="Up to 5 decimal places. Use a dot for decimals.">
          <TextInput
            id="x-amount"
            className="input-amount num"
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            placeholder="0"
            onChange={(e) => setAmountText(e.target.value)}
            invalid={Boolean(amountError)}
          />
        </Field>
        <p className="paid-by">
          Paid by <strong>you</strong>. Tally records only what you paid yourself; whoever paid adds their own expenses.
        </p>

        <fieldset className="fieldset">
          <legend className="field-label">Split</legend>
          <Segmented
            label="Split method"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'equal', label: 'Equally' },
              { value: 'exact', label: 'Amounts' },
              { value: 'percent', label: 'Percent' },
            ]}
          />
          <ul className="split-list">
            {active.map((m) => {
              const on = included.has(m);
              const share = split.ok ? split.shares.find((sh) => sh.member === m) : undefined;
              return (
                <li key={m} className={on ? '' : 'off'}>
                  <label className="check">
                    <input type="checkbox" checked={on} onChange={() => toggle(m)} />
                    <span>{nameOf(who, m)}</span>
                  </label>
                  {on && method === 'exact' && (
                    <TextInput
                      aria-label={`${nameOf(who, m)}'s amount in NIM`}
                      className="input-inline num"
                      inputMode="decimal"
                      value={exact[m] ?? ''}
                      placeholder="0"
                      onChange={(e) => setExact({ ...exact, [m]: e.target.value })}
                    />
                  )}
                  {on && method === 'percent' && (
                    <span className="pct">
                      <TextInput
                        aria-label={`${nameOf(who, m)}'s percentage`}
                        className="input-inline num"
                        inputMode="decimal"
                        value={percent[m] ?? ''}
                        placeholder="0"
                        onChange={(e) => setPercent({ ...percent, [m]: e.target.value })}
                      />
                      %
                    </span>
                  )}
                  {on && method === 'equal' && (share ? <Amount luna={share.amount} size="sm" /> : <span className="muted">-</span>)}
                </li>
              );
            })}
          </ul>
          {(splitError || nobodyElse) && (
            <p className="field-error" role="alert">
              {splitError ?? nobodyElse}
            </p>
          )}
        </fieldset>

        {split.ok && owedByOthers.length > 0 && (
          <section className="preview" aria-labelledby="preview-h">
            <h2 id="preview-h" className="h-block">
              Who will be asked
            </h2>
            <ul className="preview-list">
              {owedByOthers.map((sh) => (
                <li key={sh.member}>
                  <span>{nameOf(who, sh.member)}</span>
                  <Amount luna={sh.amount} size="sm" />
                </li>
              ))}
            </ul>
            {split.remainderNote && <p className="fineprint">{split.remainderNote}</p>}
            <p className="fineprint">
              Each person is asked to agree to their share. Nothing counts as owed until they do. Your own share of {formatNim(split.shares.find((sh) => sh.member === me)?.amount ?? 0n)} NIM is just yours.
            </p>
          </section>
        )}

        <fieldset className="fieldset">
          <legend className="field-label">Category</legend>
          <div className="chips">
            {CATEGORIES.map((c) => (
              <button key={c} type="button" className={`chip${category === c ? ' on' : ''}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Date" htmlFor="x-date">
          <TextInput id="x-date" type="date" value={spentOn} max={today()} onChange={(e) => setSpentOn(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="x-note" hint="Optional, visible to everyone in the tab.">
          <textarea id="x-note" className="input textarea" rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Alert tone="error" title="Not saved">{error}</Alert>}
        <div className="form-actions sticky">
          <Button type="submit" block busy={busy}>
            {owedByOthers.length > 0 ? `Ask ${owedByOthers.length} ${owedByOthers.length === 1 ? 'person' : 'people'} to agree` : 'Save expense'}
          </Button>
        </div>
      </form>
    </div>
  );
}
