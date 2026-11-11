import { computePlan } from '@tally/core/netting';
import { useState } from 'react';
import { REPO_URL, appOrigin, nimiqPayDeeplink } from '../lib/config.js';
import { formatNim } from '../lib/money.js';
import { Mark, Wordmark } from '../ui/brand.js';
import { QrCode } from '../ui/qr.js';
import '../styles/landing.css';

/** The worked example Tally has always published, computed live by the real netting engine. */
const PEOPLE = { ada: 'a'.repeat(40), bo: 'b'.repeat(40), cy: 'c'.repeat(40), dee: 'd'.repeat(40) } as const;
const NAME: Record<string, string> = { [PEOPLE.ada]: 'Ada', [PEOPLE.bo]: 'Bo', [PEOPLE.cy]: 'Cy', [PEOPLE.dee]: 'Dee' };
const NIM = 100_000n;
const DEBTS = [
  { debtor: PEOPLE.ada, creditor: PEOPLE.bo, amount: 50n * NIM, what: 'tram passes' },
  { debtor: PEOPLE.bo, creditor: PEOPLE.cy, amount: 50n * NIM, what: 'groceries' },
  { debtor: PEOPLE.cy, creditor: PEOPLE.ada, amount: 50n * NIM, what: 'museum' },
  { debtor: PEOPLE.ada, creditor: PEOPLE.dee, amount: 120n * NIM, what: 'the flat' },
  { debtor: PEOPLE.bo, creditor: PEOPLE.dee, amount: 30n * NIM, what: 'dinner' },
];
const PLAN = computePlan(Object.values(PEOPLE), DEBTS, 'minimal');

function openUrl(): string {
  return nimiqPayDeeplink(`${appOrigin()}/app`);
}

function ExampleTab() {
  const [netted, setNetted] = useState(false);
  return (
    <figure className="ex-tab" aria-labelledby="ex-cap">
      <div className="ex-head">
        <div>
          <p className="ex-name">Lisbon weekend</p>
          <p className="ex-meta">Ada, Bo, Cy and Dee</p>
        </div>
        <span className="ex-flag">Example</span>
      </div>
      <div className="ex-count" aria-live="polite">
        <span className="ex-n num">{netted ? PLAN.transfers.length : DEBTS.length}</span>
        <span className="ex-l">{netted ? 'payments settle everything' : 'debts between four friends'}</span>
      </div>
      <ul className="ex-list">
        {netted
          ? PLAN.transfers.map((t) => (
              <li key={`${t.from}${t.to}`} className="ex-row ex-row-pay">
                <span>
                  <strong>{NAME[t.from]}</strong> pays <strong>{NAME[t.to]}</strong>
                </span>
                <span className="num">{formatNim(t.amount)} NIM</span>
              </li>
            ))
          : DEBTS.map((d) => (
              <li key={d.what} className="ex-row">
                <span>
                  {NAME[d.debtor]} owes {NAME[d.creditor]} <span className="ex-what">for {d.what}</span>
                </span>
                <span className="num">{formatNim(d.amount)} NIM</span>
              </li>
            ))}
      </ul>
      {netted && <p className="ex-cy">Cy pays nothing and is paid nothing. Their debts went in a circle and cancelled out.</p>}
      <button type="button" className="ex-toggle" onClick={() => setNetted((n) => !n)} aria-pressed={netted}>
        {netted ? 'Show the original debts' : 'Settle it the Tally way'}
      </button>
      <figcaption id="ex-cap" className="visually-hidden">
        An example tab. Five debts between four people reduce to two payments. Savings depend on how a group’s debts connect.
      </figcaption>
    </figure>
  );
}

function Graph({ after }: { after: boolean }) {
  const pos: Record<string, [number, number]> = { Ada: [70, 46], Bo: [196, 130], Cy: [70, 214], Dee: [350, 130] };
  const edges: [string, string, string][] = after
    ? PLAN.transfers.map((t) => [NAME[t.from] as string, NAME[t.to] as string, formatNim(t.amount)])
    : DEBTS.map((d) => [NAME[d.debtor] as string, NAME[d.creditor] as string, formatNim(d.amount)]);
  return (
    <svg viewBox="0 0 410 260" className="graph" role="img" aria-label={after ? 'After netting: Ada pays Dee 120 NIM, Bo pays Dee 30 NIM.' : 'Before: five debts between Ada, Bo, Cy and Dee.'}>
      <defs>
        <marker id={`arrow-${after ? 'a' : 'b'}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill={after ? 'var(--action)' : 'var(--ink-3)'} />
        </marker>
      </defs>
      {edges.map(([from, to, amt], i) => {
        const [x1, y1] = pos[from] as [number, number];
        const [x2, y2] = pos[to] as [number, number];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        const sx = x1 + (dx / len) * 30;
        const sy = y1 + (dy / len) * 30;
        const ex = x2 - (dx / len) * 34;
        const ey = y2 - (dy / len) * 34;
        const mx = (sx + ex) / 2 - (dy / len) * 14;
        const my = (sy + ey) / 2 + (dx / len) * 14;
        return (
          <g key={i}>
            <path d={`M${sx} ${sy}Q${mx} ${my} ${ex} ${ey}`} fill="none" stroke={after ? 'var(--action)' : 'var(--ink-3)'} strokeWidth={after ? 3 : 2} markerEnd={`url(#arrow-${after ? 'a' : 'b'})`} />
            <text x={mx} y={my - 6} textAnchor="middle" className="graph-amt">
              {amt}
            </text>
          </g>
        );
      })}
      {Object.entries(pos).map(([n, [x, y]]) => (
        <g key={n}>
          <circle cx={x} cy={y} r="26" fill={after && n === 'Cy' ? 'var(--surface)' : 'var(--canvas)'} stroke="var(--ink)" strokeWidth="2" strokeDasharray={after && n === 'Cy' ? '4 4' : undefined} />
          <text x={x} y={y + 5} textAnchor="middle" className="graph-name">
            {n}
          </text>
        </g>
      ))}
    </svg>
  );
}

const FAQ: [string, string][] = [
  ['Do I need Nimiq Pay?', 'Yes. Tally is a Mini App inside the Nimiq Pay wallet. That is where your NIM is and where every payment is approved. In a normal browser you can read about Tally but not use a tab.'],
  ['How are payments made?', 'Each person pays their own part from their own Nimiq Pay wallet, to the person they owe, in NIM on Nimiq mainnet. Nimiq Pay shows you the recipient and amount and asks you to approve every payment.'],
  ['Can someone add a debt to my name?', 'They can ask. Nothing counts as owed until you agree to it yourself, and you can decline any request. A declined share stays visible as declined.'],
  ['What does it cost?', 'Tally is free and open source, with no fee on top of payments. Nimiq Pay picks the network fee for each payment, which for ordinary NIM payments is usually zero. Nimiq Pay shows it before you approve.'],
  ['Who can see a tab?', 'Anyone who has its link. Share it only with the people in the tab. Payments are public on the Nimiq network, like all Nimiq payments.'],
  ['What if I close the app mid-payment?', 'Tally saves the payment before Nimiq Pay asks you to approve. When you come back it checks the network for it, and it will not let you pay again until it knows whether the first one went out.'],
];

export default function Landing() {
  const [graphAfter, setGraphAfter] = useState(false);
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <a href="/" aria-label="Tally home">
            <Wordmark height={28} />
          </a>
          <nav aria-label="Page">
            <a href="#how">How it works</a>
            <a href="#why">Why Tally</a>
            <a href="#safety">Safety</a>
          </nav>
          <a className="lp-btn lp-btn-sm" href={openUrl()}>
            Open in Nimiq Pay
          </a>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-in">
            <div className="lp-hero-copy">
              <h1>Shared expenses. Actually settled.</h1>
              <p className="lp-lede">
                Tally keeps one tab for your group. Everyone agrees to their own share, debts that go in a circle cancel out, and each person pays the rest in NIM from Nimiq Pay. The tab shows which payments the network confirmed.
              </p>
              <div className="lp-ctas">
                <a className="lp-btn" href={openUrl()}>
                  Open in Nimiq Pay
                </a>
                <a className="lp-btn lp-btn-ghost" href="#how">
                  See how it works
                </a>
              </div>
              <p className="lp-small">Free and open source. Runs on Nimiq mainnet.</p>
            </div>
            <ExampleTab />
          </div>
        </section>

        <section className="lp-sec lp-problem" aria-labelledby="problem-h">
          <div className="lp-wrap lp-split">
            <div>
              <h2 id="problem-h">Dinner is over. Everyone says they’ll send it.</h2>
              <p>
                Someone covered the flat, someone else the train, and the group chat fills up with promises. A week later the person who paid is still scrolling up to work out who sent what. A spreadsheet can tell you who owes whom. It cannot tell you who actually paid.
              </p>
            </div>
            <div className="lp-compare">
              <div className="chat" aria-label="A group chat, dramatised">
                <span className="chat-tag">The group chat</span>
                <p className="bubble">I’ll send you my half tonight</p>
                <p className="bubble bubble-r">did you get the 30 from Bo?</p>
                <p className="bubble">wait who paid for the museum</p>
                <p className="bubble bubble-r">I think I owe Cy? or Cy owes me</p>
                <p className="bubble">sent! (did I?)</p>
              </div>
              <div className="tabcard" aria-label="The same week in a Tally tab, example">
                <span className="chat-tag">The same week in Tally</span>
                <ul>
                  <li>
                    <span>Bo agreed to 30 NIM for dinner</span>
                    <span className="st st-agreed">Agreed</span>
                  </li>
                  <li>
                    <span>Ada paid Dee 120 NIM</span>
                    <span className="st st-paid">Confirmed</span>
                  </li>
                  <li>
                    <span>Bo is paying Dee 30 NIM</span>
                    <span className="st st-checking">Checking</span>
                  </li>
                  <li>
                    <span>Cy owes nobody</span>
                    <span className="st">Square</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec" id="how" aria-labelledby="how-h">
          <div className="lp-wrap">
            <h2 id="how-h" className="lp-h-center">
              From expense to settled, in three steps
            </h2>
            <ol className="steps">
              <li>
                <span className="step-n">1</span>
                <h3>Record</h3>
                <p>Whoever paid adds it: what it was, the total, and how to split it. Equally, by exact amounts or by percentage, down to the last Luna.</p>
                <div className="mini">
                  <p className="mini-title">Dinner at Taberna</p>
                  <p className="mini-amt num">60 NIM</p>
                  <p className="mini-sub">Split equally between Ada, Bo and Dee</p>
                </div>
              </li>
              <li>
                <span className="step-n">2</span>
                <h3>Agree</h3>
                <p>Each person sees the request and agrees to their share, or declines it. Nothing is owed until the person who owes it says so.</p>
                <div className="mini">
                  <p className="mini-q">You agree you owe 20 NIM to Ada for Dinner at Taberna.</p>
                  <div className="mini-btns">
                    <span className="mini-yes">Yes, I agree</span>
                    <span className="mini-no">Decline</span>
                  </div>
                </div>
              </li>
              <li>
                <span className="step-n">3</span>
                <h3>Pay</h3>
                <p>Tally works out the fewest payments. You pay your part in Nimiq Pay, and it shows as paid once the network confirms it.</p>
                <div className="mini">
                  <p className="mini-title">Pay Ada</p>
                  <p className="mini-amt num">20 NIM</p>
                  <span className="mini-pay">Pay 20 NIM</span>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="lp-sec lp-why" id="why" aria-labelledby="why-h">
          <div className="lp-wrap lp-split lp-split-wide">
            <div>
              <h2 id="why-h">Fewer payments, because circles cancel</h2>
              <p>
                In this example Ada owes Bo, Bo owes Cy and Cy owes Ada the same amount, so that loop disappears. What is left is two payments to Dee. Tally adds up each person’s balance and pairs the people who owe with the people who are owed.
              </p>
              <p className="lp-small">
                An example, not a promise: how much a group saves depends on how its debts connect. Tally never needs more than one payment fewer than the number of people.
              </p>
              <div className="seg" role="radiogroup" aria-label="Show the graph">
                <button type="button" role="radio" aria-checked={!graphAfter} className={graphAfter ? '' : 'on'} onClick={() => setGraphAfter(false)}>
                  5 debts
                </button>
                <button type="button" role="radio" aria-checked={graphAfter} className={graphAfter ? 'on' : ''} onClick={() => setGraphAfter(true)}>
                  2 payments
                </button>
              </div>
            </div>
            <Graph after={graphAfter} />
          </div>
        </section>

        <section className="lp-sec" aria-labelledby="confirm-h">
          <div className="lp-wrap lp-split">
            <div className="phone" aria-hidden>
              <div className="phone-in">
                <p className="ph-title">Payment</p>
                <p className="ph-amt num">20 NIM to Ada</p>
                <ol className="ph-tl">
                  <li className="done">Approve in Nimiq Pay</li>
                  <li className="done">Sent to the network</li>
                  <li className="done">Seen in a block</li>
                  <li className="now">Confirmed on Nimiq</li>
                </ol>
                <div className="ph-receipt">
                  <Mark size={20} />
                  <span>Paid, confirmed on Nimiq</span>
                </div>
              </div>
            </div>
            <div>
              <h2 id="confirm-h">A promise is not a payment. Tally knows the difference.</h2>
              <p>
                A share you agreed to is a promise. A payment your wallet sent is a claim. Tally only marks a payment as paid when it has found it on the Nimiq network itself, sent to the right person, for the exact amount, and final.
              </p>
              <p>
                If Nimiq Pay cannot say whether a payment went out, Tally checks the network for it before letting you pay again. Nobody pays twice because a screen froze.
              </p>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-safety" id="safety" aria-labelledby="safety-h">
          <div className="lp-wrap lp-narrow">
            <h2 id="safety-h">You stay in control</h2>
            <div className="acc">
              <details open>
                <summary>Every debt needs the debtor’s yes</summary>
                <p>Requests sit as requests until the person named agrees, and they can decline. Agreements are signed by a key on that person’s phone, which they authorised with their wallet, so nobody can agree on their behalf.</p>
              </details>
              <details>
                <summary>Every payment is approved in Nimiq Pay</summary>
                <p>Tally never holds your NIM and cannot move it. Each payment opens Nimiq Pay’s own approval screen with the recipient and amount. An earlier version could pay automatically from a small app-held balance; it is switched off.</p>
              </details>
              <details>
                <summary>Anyone with a tab’s link can read it</summary>
                <p>There is no account or password, so the link is the key to reading a tab: names, amounts and addresses. Share it only with your group. Changing a tab always needs a member’s own signature.</p>
              </details>
              <details>
                <summary>The server cannot rewrite your tab</summary>
                <p>Tally’s server stores signed entries and passes them on. Your app checks every signature itself and checks payments directly on the Nimiq network, so the server cannot invent a debt or mark something paid.</p>
              </details>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-final" aria-labelledby="final-h">
          <div className="lp-wrap lp-final-in">
            <div>
              <h2 id="final-h">Keep one tab for the group you keep spending with.</h2>
              <p>Trips end, but flats, teams and Thursday dinners keep going. Your tab stays put, so the next expense starts where the last one settled.</p>
              <div className="lp-ctas">
                <a className="lp-btn" href={openUrl()}>
                  Open in Nimiq Pay
                </a>
              </div>
            </div>
            <div className="lp-qr">
              <QrCode value={openUrl()} label="QR code that opens Tally in Nimiq Pay" size={160} />
              <p>Scan with your phone to open Tally in Nimiq Pay.</p>
            </div>
          </div>
          <div className="lp-wrap lp-narrow">
            <h2 className="lp-faq-h">Questions</h2>
            <div className="acc">
              {FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <Wordmark height={24} />
          <nav aria-label="Footer">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source code
            </a>
            <a href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
              Security and limits
            </a>
            <a href="https://nimiq.com" target="_blank" rel="noreferrer">
              Built on Nimiq
            </a>
          </nav>
          <p className="lp-small">MIT licensed. Tally is an independent Nimiq Pay Mini App, not a Nimiq product.</p>
        </div>
      </footer>
    </div>
  );
}
