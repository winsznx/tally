# On-device gate tests — numbered script

Run these on a real Android phone with **Nimiq Pay on testnet**. They clear the
Phase 0 gate that decides whether the purse mechanic (auto-settle) ships. Report
back per step: **PASS/FAIL + the copied JSON**. Under manual-mode-first, a Test 2
failure costs the purse feature, not the product.

**Setup**
1. `cd /Users/mac/tally && npm run dev -- --host`. Note the Network URL
   (`http://<lan-ip>:5173`). Once the shell is deployed, prefer the **HTTPS Pages
   URL** instead — it is a secure context, so `crypto.randomUUID` is available
   and the whole insecure-context question disappears from this run.
2. In Nimiq Pay, switch to **testnet** (hidden dev menu: 10-second long-press on
   the settings button).
3. Empty-state home → **Get free NIM** (110,000 testnet NIM per tap). Tap 3–4×.
4. Open **Discover** and type the URL into the **“Search or enter App URL”**
   field. The app loads, and then persists under **Recently Viewed** — so the URL
   is entered once per device, not every time.

   > This is also the **demo path**: loading Tally through Discover on camera
   > shows it running natively inside the wallet rather than in a browser.

**Test E — environment (auto-runs, no button)**
5. Read the `env` card. Record: `innerHeight`/`innerWidth`,
   `visualViewport.height`, safe-area insets, `isSecureContext`,
   `crypto.randomUUID` availability, `nimiqPay.language`, `userAgent`.
   → Expected: the design team needs the real viewport height; note how much the
   Nimiq Pay chrome takes vs the assumed 390×844.

**Test R — RPC allowlist (0 dialogs, 6 requests)**
6. Tap **Run Test R**. → Expected: all six methods **ALLOWED** (matches the curl
   result); "address history over RPC: AVAILABLE".

**Test 2 — locally-signed broadcast (THE decider, 1 dialog)**
7. Tap **Run Test 2**. Approve the ONE funding dialog when it appears.
8. Watch step 5 ("signing locally NOW"). → Expected: **no dialog** appears while
   signing. If one does, that is itself the finding — record it.
9. Wait for step 6a/6b (client + RPC broadcast) and step 7 (landing).
   → **PASS** if either path lands. **FAIL on both** → stop, report immediately.

**Test M — manual-mode determinism (1 dialog)**
10. Tap **Run Test M**. Approve the dialog.
11. Read the verdict. → **PASS** = wallet honoured explicit `fee:0` AND
    `validityStartHeight` (manual mode keeps the one-payment guarantee).
    **BROKEN** = it overrode a field (manual mode needs round-level locking).

**Test 2b·A — byte determinism, single device (0 dialogs)**
12. Tap **Run Test 2b Part A**. → **PASS** = the two builds are byte-identical
    (hash + serialized bytes).

**Test 2b·B — two-device race (needs a second phone)**
13. On phone 1: Test 2b·B → **Generate** a key → **Fund 2 NIM** (approve) →
    copy the hex key.
14. On phone 2: load the harness, paste the same hex key into Test 2b·B, set the
    same recipient.
15. On BOTH: **Read chain head** → copy ONE head value to both `validityStartHeight`
    fields (shared state). Tap **Build & show hash** on both — the hashes must
    match before broadcasting.
16. On BOTH, as simultaneously as you can: **BROADCAST NOW**.
17. On either: **Poll recipient balance / chain evidence**. → **PASS** = exactly
    ONE transfer landed (balance moved by one amount). **FAIL** = two.
18. Repeat 13–17 with the two phones reading DIFFERENT head heights (skip step
    15's "copy one value"; use each phone's own **Read chain head**). → This
    proves `validityStartHeight` must come from shared state: divergent heads
    should produce two transactions (the failure the design prevents by taking
    the height from ROUND_OPEN).

**Test 3 — 64-byte data field (5 dialogs)**
19. Tap **Run Test 3**. Approve five dialogs. → Records the true byte ceiling and
    whether the limit counts bytes or characters.

**Test 4 — light client timing (0 dialogs)**
20. Tap **Run Test 4** on wifi, then reload and run again on a throttled
    connection. → Records wasm/create/consensus ms and peer count.

**Finish**
21. Tap **Copy all results as JSON** and send it back. Sweep any testnet funds
    from the harness's local key first (printed in the Test 2 log).
