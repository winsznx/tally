# Decisions

What was considered and rejected, and why. The rejections shaped the product more than the features did, because most of them died on a framework constraint that no amount of engineering removes.

The binding constraint throughout: Nimiq has no general-purpose VM, and the mini app provider exposes no arbitrary transaction signing and no contract creation. Native HTLC, vesting and staking contracts exist at protocol level, but a mini app can't create or redeem them. Anything needing escrow, conditional release or programmable custody isn't buildable here.

## Rejected products

| Option | Why it was considered | Why it was rejected |
| --- | --- | --- |
| Payment streams, per-second accrual | Continuous settlement is a natural fit for feeless transfers, and the demo looks good | Unenforceable without contracts. The accrual counter would be a UI drawn over a promise, with nothing stopping the payer from closing the app. Showing a number that implies an obligation nobody can enforce is the kind of thing the rules prohibit |
| Signed receipts as the product | Genuinely useful, cryptographically clean, and easy to verify | Nobody reopens a receipts app. There's no return trigger, and with no push channel available, retention has to come from another person doing something. A receipt is the end of an interaction, not a reason to come back |
| Offline bearer cash, handoff notes | Would work where connectivity doesn't, and the mini app WebView can hold state | Double spend is unsolvable offline without secure hardware. You can make it detectable after the fact, but the honest version of the first screen has to say your money may already be spent, which is not a product. WebView caching behaviour under Nimiq Pay is also unverified |
| Reusable container deposit clearing | The right idea. Deposits are exactly the kind of small recurring obligation feeless transfers suit | Wrong population for this cycle. Two-sided cold start needs both cafes and customers, it needs physical tags, and there's nothing testable on day one. The mechanic is sound and the logistics kill it |
| HTLC-based content unlock | Atomic pay-for-content with no trusted party is the classic use for hash locks | Dead on the API. HTLC creation isn't reachable through the mini app provider, so there's no way to build one from inside a mini app. Not a judgment call, a missing capability |
| USDT or EVM settlement | Broader reach, and stablecoin denomination avoids volatility questions | Gas breaks the entire premise. Auto-settling small amounts requires the user to hold a gas token and pre-approve spends. Rejecting this is a design position: the mechanic only functions on a feeless rail, and the write-up says so |
| Custodial escrow | Would let Tally guarantee settlement instead of merely evidencing it | No enforcement primitives exist here, so any escrow is either genuinely custodial, meaning we hold user funds and become the thing the product argues against, or it's theatre. Neither ships |

## Decisions inside Tally

### Obligations are denominated in NIM and fixed when created

An obligation records an amount in Luna at the moment it's proposed, and that number never changes.

The tempting alternative is denominating in fiat and converting at settlement, so "you owe me 12 euros" stays 12 euros. It's rejected because an exchange rate is a non-deterministic input read at settlement time, and determinism is the whole mechanism that prevents double payment. Two devices building the same leg three seconds apart would read different rates, produce different transaction bytes, and pay twice. Every field of a settlement transaction is derived from the signed log for exactly this reason, and a live rate is the opposite of derived.

A display-only rate is fine, because it never touches the plan.

### Settlement lands in the account, not the counterparty's purse

Netting runs over account addresses, because that's who owes whom. The transaction sender is swapped to the payer's purse, since that's where the funds are, but the recipient stays the creditor's real Nimiq Pay account.

Paying into the creditor's purse would be worse in two ways. It would put money the recipient hasn't asked to hold into a hot key, and it would make received funds invisible in their actual wallet. A creditor should be paid where they keep their money. The purse is funded only by an explicit top up its owner approved.

### Silence is never consent

An obligation enters netting only after the named debtor signs an explicit acceptance. Not viewing it, not failing to dispute it, not letting it age. A proposed obligation can sit untouched forever and will never move a single Luna.

The alternative, auto-accepting after some window, would make the app better at collecting debts and much worse at being trustworthy. It also creates an obvious abuse: propose a debt, wait, get paid. Acceptance costs one tap and no dialog, which is the correct price. Taps buy consent, dialogs buy money.

Rejection moves an edge to contested with both signatures on the record, rather than deleting it.

### No invite approval step

Anyone holding a ledger link can read the whole tab. Ledger ids are 128 random bits, so links aren't guessable, but there's no access control beyond holding one.

An approval step was considered and rejected. It adds friction to a 60 second onboarding target, for a threat model that doesn't warrant it: everything in the tab is already visible to everyone in it, and settlement amounts and addresses are public on chain by construction. The mitigation is disclosure, not a gate. The share sheet says in plain words that anyone with the link can see the tab, and [SECURITY.md](SECURITY.md) says it again.

### The purse is generated, not derived from the signature

The PRD's primary design derives the purse from the binding signature, so it re-derives on any device with no backup. That needs the signed message to name the purse public key, which you can't do before deriving it, so doing both would take two separate account signatures on top of address selection. The derivation signature also can't be published, because its hash is the purse seed.

So the purse is generated randomly and attested with one signature, which is the PRD's own documented fallback. Accountability is unchanged, the binding still proves which account the purse speaks for, and nothing depends on `nimiq.sign()` being deterministic, which the device gate hasn't yet confirmed. See the dialog-count decision below for what this costs at join time.

### Joining costs two dialogs, and the one-dialog alternative was rejected

Joining takes two approvals: `listAccounts` to choose the address, then the
binding signature. The second is structural. A member's very first log entry
must already carry an attested purse, and the attestation has to name the purse
inside a publishable message, so the purse must exist before the signature and
the address must be known before the message.

The one-dialog alternative was considered: generate the purse randomly, skip
address selection by recovering the account from the signature's returned public
key, and back the purse key up to the relay encrypted under a signature-derived
key. It was rejected because it trades cross-device recovery that needs nothing
written down for one dialog nobody will notice, and it makes recovery depend on
an untrusted relay being reachable. A relay that is down would stop being an
inconvenience and start being data loss.

The PRD originally estimated one dialog for joining. That was wrong, and the PRD
has been corrected rather than the number quietly restated.

### Manual mode is a first-class path, not a fallback

Manual settlement is built as a complete product in its own right: same netting, same anchoring, same reconciliation, same log, one dialog per leg. The purse layers on top and is never a dependency.

This is deliberate insurance. An app-managed hot key is an ordinary user-funded pattern, but it isn't an endorsed framework feature. If a reviewer reads it as outside the framework's expectations, we lose one feature rather than the product.
