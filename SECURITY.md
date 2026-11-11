# Security model

Tally is not a bank, an escrow or a debt collector. It records signed agreements and checks real NIM payments on chain. The two failures it is built to prevent are **paying twice** and **believing a payment happened when it did not**. This document says what Tally guarantees and what it does not.

## Keys

| Key | Where it lives | Can | Cannot |
| --- | --- | --- | --- |
| Your Nimiq Pay wallet key | Nimiq Pay, never exposed to Tally | Sign the one sign-in message; approve each payment in Nimiq Pay's own prompt | Be read or used by Tally without your approval |
| Device key | Generated in the app, kept in the WebView's storage | Sign your tab entries: expenses, agreements, declines, withdrawals, payment claims | Move or spend NIM. It holds none and the wallet never accepts it |

The sign-in message is shown in Nimiq Pay and says, in words, that it lets the device record agreements and cannot move or spend NIM. It names the account and the device key exactly. Every member's sign-in signature is published in their join entry, so anyone can check that a device key speaks for that account. Small-order and all-zero keys are rejected before verification ([REVIEWS.md](REVIEWS.md)).

**The device key is the sensitive part.** Someone with control of your unlocked phone, or an XSS bug in Tally, could use it to agree to a request in your name. They could not pay anything: every payment still needs your approval in Nimiq Pay. Signing out on a device forgets its key.

Identity is the address derived from the sign-in signature's public key. `listAccounts()` only shares addresses and proves nothing, and Nimiq Pay chooses the signer, so Tally never assumes the first listed address signed.

## Automatic payments are off

Cycle I could fund an app-held "purse" key and pay from it without prompts. It is switched off in this version. Nimiq Pay now holds spendable NIM in an HTLC co-signed with Nimiq Pay that rotates about weekly, and a hot key in a WebView is lost with the phone or leaked by one XSS bug. The core still contains the old purse transaction builder and its tests for log compatibility; nothing in the app can fund or spend a purse.

## Payments

- **Consent.** A debt exists only after the named person signs their agreement. Silence never counts. A creditor can withdraw or forgive, which only lowers what someone owes.
- **Paid means confirmed on chain.** A payment claim counts only when this device reads the transaction from a Nimiq RPC endpoint and finds: the claimed hash, mainnet, the claimed recipient, the exact amount, the claim's memo, successful execution, and a block at or before the latest macro block (finality). A wallet-returned hash, the server's opinion, or another member's claim never marks anything paid.
- **No claiming someone else's payment.** The memo carries a reference derived from the payer's address and a secret salt, revealed only in the payer's signed claim.
- **No double payment from retries.** The payment intent is saved before Nimiq Pay's prompt opens. If the app closes mid-prompt or Nimiq Pay cannot say whether it sent, the intent becomes *unknown* and Tally looks for its memo on chain. It refuses to start another payment from you in that tab until the first resolves, or until its validity window (7,200 blocks) has passed with nothing found.
- **If two payments do land** (for example two devices racing past the checks), both are credited at their real amounts, so the second shows as money the recipient owes back. Nothing is lost silently.

## The server

The API stores signed entries and indexes payment intents. It re-validates every entry with the same core code the app uses and refuses forged, malformed or non-member entries, but the app trusts none of it: every entry is re-verified on the device, and payment status comes from the device's own chain reads. The server can withhold or reorder entries; it cannot forge an agreement or a payment. Entries and chain observations are append-only at the database level.

Operationally: exact-origin CORS, per-route rate limits, a 256 KB body limit, parameterised SQL, no secrets in the frontend bundle, secrets only in the VPS environment.

## Privacy

Anyone with a tab's link can read the tab: names, amounts, addresses, notes. There is no approval step; the app says so when you create, share and join. Payments are public on chain. Tally keeps your list of tabs on your device only, because a server lookup by address would let anyone who knows your address find your tabs. Usage counts are off by default and contain no addresses, names, amounts or tab ids when turned on.

## Known limits

- **Trust on first use.** The first time you open a tab, you see the member list the server gives you. Each member is cryptographically bound to their account, but you trust that the person behind it is who you think. See [docs/issues/0001-tofu-member-registration.md](docs/issues/0001-tofu-member-registration.md).
- **Equivocation is detected, not prevented.** A server showing different histories to different members is caught by comparing exported signed logs; there is no automatic gossip between clients yet.
- **Finality waits for the macro block.** Nimiq Pay's co-signed payments feel instant in the wallet; Tally waits for the next macro block (usually under a minute) before calling a payment final.

## Reporting

Please open a GitHub issue, or for anything sensitive contact the maintainer through their GitHub profile first.
