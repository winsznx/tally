import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { inviteUrl, nimiqPayDeeplink } from '../../lib/config.js';
import { forgetTab } from '../../lib/registry.js';
import { nameOf, people } from '../../lib/view.js';
import { Address, QrCode, TopBar } from '../../ui/bits.js';
import { Alert, Amount, Button, CopyButton, Pill, Sheet, Skeleton } from '../../ui/primitives.js';
import { useSession, useTab } from '../context.js';

/** S12: who is in the tab, inviting more, leaving. */
export function Members() {
  const { tabId = '' } = useParams();
  const [params] = useSearchParams();
  const s = useSession();
  const nav = useNavigate();
  const { snapshot, store } = useTab(tabId);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const me = s.identity?.address ?? '';
  const st = snapshot.state;
  if (!st.genesisHash) {
    return (
      <div className="screen">
        <TopBar title="People" back={`/app/tabs/${tabId}`} />
        <Skeleton lines={5} />
      </div>
    );
  }
  const who = people(snapshot, me);
  const link = inviteUrl(tabId);
  const myPosition = snapshot.settlement.positions.get(me) ?? 0n;
  const shareText = `Join “${st.ledgerName}” on Tally, our shared tab in Nimiq Pay: ${nimiqPayDeeplink(link)}`;

  async function share(): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ title: `Join ${st.ledgerName ?? 'our tab'} on Tally`, text: shareText });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    await navigator.clipboard.writeText(shareText).then(
      () => setNote('Invite copied. Paste it into your group chat.'),
      () => setNote('Copy the link below instead.'),
    );
  }

  async function leave(): Promise<void> {
    if (!s.identity) return;
    setBusy(true);
    try {
      await store.append(s.identity, 'MEMBER_LEAVE', {});
      forgetTab(tabId);
      nav('/app', { replace: true });
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not leave.');
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <TopBar title="People" sub={st.ledgerName ?? undefined} back={`/app/tabs/${tabId}`} />
      {params.get('created') && (
        <Alert tone="success" title="Your tab is ready">
          Invite the people who share these costs. They open the link in Nimiq Pay and join with one signature.
        </Alert>
      )}
      <section className="invite" aria-labelledby="invite-h">
        <h2 id="invite-h" className="h-block">
          Invite
        </h2>
        <div className="invite-body">
          <QrCode value={nimiqPayDeeplink(link)} label="QR code for this tab's invite" size={168} />
          <div className="invite-side">
            <p>Scan with a phone camera to open this tab in Nimiq Pay.</p>
            <Button onClick={() => void share()} icon={<Share2 size={18} strokeWidth={2} />}>
              Share invite
            </Button>
            <div className="invite-link">
              <span className="num">{link.replace(/^https?:\/\//, '')}</span>
              <CopyButton value={link} label="Copy invite link" />
            </div>
          </div>
        </div>
        {note && <p className="fineprint" role="status">{note}</p>}
        <p className="fineprint">Anyone with this link can read the whole tab: names, amounts and addresses. They can only change it by joining with their own wallet.</p>
      </section>

      <section className="block" aria-labelledby="people-h">
        <h2 id="people-h" className="h-block">
          In this tab
        </h2>
        <ul className="rows">
          {st.members.map((m) => {
            const pos = snapshot.settlement.positions.get(m.address) ?? 0n;
            return (
              <li key={m.address} className="row row-static">
                <div className="row-main">
                  <p className="row-title">
                    {nameOf(who, m.address, { you: false })}
                    {m.address === me && <span className="muted"> (you)</span>}
                  </p>
                  <Address hex={m.address} label={`${who.get(m.address)?.name ?? 'member'}'s address`} />
                </div>
                <div className="row-side">
                  {pos !== 0n && <Amount luna={pos < 0n ? -pos : pos} size="sm" />}
                  <Pill tone={!m.active ? 'neutral' : pos < 0n ? 'waiting' : pos > 0n ? 'agreed' : 'neutral'}>
                    {!m.active ? 'Left' : pos < 0n ? 'Owes' : pos > 0n ? 'Is owed' : 'Square'}
                  </Pill>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="fineprint pad">Names are what each person typed. The address is what their wallet proved. A member’s address can never be swapped for another.</p>
      </section>

      <section className="block">
        <Button variant="quiet" onClick={() => setLeaving(true)}>
          Leave this tab
        </Button>
      </section>

      <Sheet
        open={leaving}
        title="Leave this tab?"
        onClose={() => setLeaving(false)}
        footer={
          <>
            <Button block variant="danger" busy={busy} onClick={() => void leave()}>
              Leave tab
            </Button>
            <Button block variant="ghost" onClick={() => setLeaving(false)}>
              Stay
            </Button>
          </>
        }
      >
        <p className="sheet-statement">You will stop seeing new requests and cannot add expenses here.</p>
        {myPosition !== 0n ? (
          <Alert tone="warn">
            You {myPosition < 0n ? 'still owe' : 'are still owed'} {myPosition < 0n ? '' : ''}
            <Amount luna={myPosition < 0n ? -myPosition : myPosition} size="sm" />. Agreed shares stay on the record after you leave and still count for the group.
          </Alert>
        ) : (
          <p className="muted">You are square, so leaving changes nothing for anyone else.</p>
        )}
      </Sheet>
    </div>
  );
}
