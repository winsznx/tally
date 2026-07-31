# On-device checklist

Report back by number with PASS or FAIL and what you saw. "Step 14 FAIL, no dialog appeared" is actionable. "Settling seemed broken" is not.

**App** https://tally-646.pages.dev
**Relay** https://tally-relay.timjosh507.workers.dev

Both are HTTPS, so this is a secure context and `crypto.randomUUID` is available. The insecure-context question from the LAN runs no longer applies.

## A0. The Demo URL, 15 seconds from cold

Do this first. It is what a judge sees.

1. Open **Discover**, type `tally-646.pages.dev`.
   Expected: an entry screen. "Keep a running tab with your people", **See a live example** as the main button, "Start a tab" below it. Not an empty tab, not a dead button.
2. Tap **See a live example**.
   Expected: a populated ledger. Four people, "4 people, 3 with something outstanding", 1,500 NIM outstanding, and a read-only notice saying nothing has touched your wallet.
3. Tap **Preview settlement**.
   Expected: five obligations collapse to **two transfers**, Ada to Dee 1,200 and Bo to Dee 300, with a line saying Cy nets to zero and never has to open the app.
   This is the strongest thing the product does and it should take three taps from a cold URL.

## A. Setup

4. In Nimiq Pay, switch to **testnet** (10-second long-press on the settings button).
5. Empty-state home, tap **Get free NIM** three or four times. You need roughly 2,000 testnet NIM to cover a 1,200 settlement plus a purse top-up.
6. Confirm the app persists under **Recently Viewed**, so the URL is typed once per device.

## B. Gate tests, still unrun

These decide whether the purse mechanic ships. Run them against the harness, which is a separate app: `cd /Users/mac/tally && npm run dev -- --host`, then load the LAN URL through Discover. Full script in [on-device-gate-tests.md](on-device-gate-tests.md).

7. **Test E**, environment. Auto-runs. Record real viewport height and safe-area insets, and confirm `isSecureContext` is now true when loaded over the deployed HTTPS URL.
8. **Test R**, RPC allowlist. Expected: all six methods allowed.
9. **Test 2**, locally-signed broadcast. Approve the one funding dialog. Watch step 5: **no dialog should appear while signing**. If one does, that is the finding. PASS if either broadcast path lands. FAIL on both means stop, and the purse mechanic is dead.
10. **Test M**, manual determinism. Expected PASS: the wallet honoured explicit `fee: 0` and `validityStartHeight`.
11. **Test 2b Part A**, byte determinism, single device. Expected: identical hash and bytes.
12. **Test 2b Part B**, two devices. Needs a second phone. Expected: exactly one transfer lands.

## C. Seed the demo tab

13. On your laptop: `pnpm seed:demo --relay https://tally-relay.timjosh507.workers.dev --origin https://tally-646.pages.dev`
    Expected: it prints Bo, Cy and Dee as members, two accepted debts, and an invite URL. It then waits.
14. Open the printed URL on your phone through Discover.
    Expected: you see the tab **read-only**, with Bo's two debts visible and no wallet prompt so far.

## D. Join as Ada

15. Tap **Join this tab**.
    Expected: a `listAccounts` dialog, then a signing dialog for the binding message. Two prompts. Approve both.
16. Watch the laptop.
    Expected: the seeder detects your join, adds Cy owes Ada 500 as accepted, and leaves two obligations awaiting you. It prints the plan it expects and the invite URL again.
17. Back on the phone, pull to refresh or tap retry.
    Expected: your position shows and **two requests are waiting on you**: you owe Bo 500 and you owe Dee 1,200.

## E. The consent model, this is demo beat 3

18. Tap **Accept** on "you owe Bo 500".
    Expected: **no wallet dialog at all**. The request disappears and your position moves.
19. Tap **Accept** on "you owe Dee 1,200".
    Expected: again no dialog. The settlement preview now appears showing **five obligations collapsing to two transfers**, with Cy noted as netting to zero.
20. Tap **Reject** on nothing yet. Instead, add a throwaway obligation with **Add expense**, then reject it from the other side later if you want to exercise it. Rejecting should mark it contested rather than deleting it.

## F. Settlement, the mechanic

21. Tap **Arm the purse**, then approve the funding dialog.
    Expected: one `sendBasicTransaction` dialog. Afterwards the purse card shows a balance and reads "auto-settle on".
22. Tap **Call the tab**.
    Expected: no dialog. A round opens and the legs appear, yours showing as waiting.
23. Tap **Settle my share**.
    Expected, and this is the whole product: **no dialog**. Your 1,200 leg broadcasts from the purse.
24. Watch the leg status.
    Expected: it shows as sending with a block countdown, and only becomes settled after the macro block, roughly a minute. If it says settled immediately, that is a bug, report it.
25. Check Dee's leg.
    Expected: still waiting, named as "waiting on Dee", since nobody is running Dee's device.

## G. Degraded states

26. Turn on airplane mode, then reopen the tab.
    Expected: the ledger still renders from cache with an offline banner. Not an error page, not a blank screen.
27. With airplane mode still on, tap **Settle my share**.
    Expected: a designed state, and no crash.
28. Turn networking back on and tap **Try again**.
    Expected: it recovers and the banner clears.
29. Start any wallet dialog and **decline** it.
    Expected: "Nothing was sent", worded as a normal outcome, with a retry. It must not look like a failure.
30. Tap **Withdraw all**.
    Expected: the purse empties back to your Nimiq Pay account, reachable without hunting for it.

## H. Manual mode

31. Tap **Withdraw all** if you have not, then reload so the purse is empty, and settle again.
    Expected: manual mode asks for **one dialog per leg**, and the button says so before you tap it.

## I. Sharing

32. Tap **Invite someone**.
    Expected: the share sheet opens, and the text says in plain words that anyone with the link can see the tab.
33. On a waiting leg, tap **Nudge**.
    Expected: a share sheet with a message, not a notification. Mini apps have no push.

## What I most need back

Steps **9, 12, 23 and 24**, in that order. Step 9 decides whether the purse mechanic exists at all, step 12 decides whether it is safe, step 23 is the moment the demo video is built around, and step 24 is the one most builders get wrong.

Steps 1 to 3 are worth a glance first because they take fifteen seconds and they are what a judge sees.
