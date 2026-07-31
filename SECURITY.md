# Security model

Tally's security rests on a small number of claims that are true, and it is
careful not to claim more. This document states both.

## The purse is a hot key (disclosed, not hidden)

The purse is an **app-managed key generated at runtime and stored in the
WebView**. It is never committed to this repository and never leaves the device.
It has two roles:

- **Role 1, log signing.** Signs obligations, acceptances, rejections, and
  round lifecycle entries. Holds no funds and risks nothing. This is an ordinary
  session key, the same pattern as sign-in-with-wallet. Present in **every**
  mode.
- **Role 2, funds custody and settlement broadcast.** Holds NIM and broadcasts
  settlement legs with no dialog. Present **only** in purse (auto-settle) mode.

**The purse balance is the entire security boundary for Role 2.** A compromised
purse, a malicious app update, an XSS flaw, or a leaked key can drain the purse
and nothing beyond it, that bound is protocol-level and absolute. It is a cash
drawer, not a vault. The app discloses this on the purse-setup screen before any
funds move, and **manual mode disables Role 2 entirely**, so a user who never
opts into the hot key loses one feature (dialog-free settlement), not the
product.

The Nimiq framework does not endorse app-managed hot keys; Tally does not claim
it does. This is an ordinary user-funded hot-wallet pattern, disclosed plainly
so a reviewer reads it as engineering rather than a bypass.

## The binding attestation is what makes accountability real

A purse signature alone proves only that *some* key signed. The
[binding attestation](packages/core/core/binding/) proves *which Nimiq Pay
account* a purse speaks for: the account holder signs a domain-separated message
naming the account and the purse, and log replay rejects any member registration
whose attestation does not verify. See that module's README for the exact Nimiq
Signed Message scheme and the verification steps.

What the binding **does** guarantee: every registered member controls the
account their purse is bound to. What it **does not**: that a given account
belongs to the specific human you expect, or that the member set you were shown
is complete. That gap is trust-on-first-use, below.

## The invite link is a capability

**Anyone holding a ledger's URL can read that entire tab from the relay**, its
members, expenses, and settlements. There is no access control beyond knowing
the id, which is 128 random bits (base32, unguessable).

This is deliberate, not an oversight. For a 2-to-12 person tab shared among
people who already know each other, an approval step would add friction to the
60-second onboarding target for a threat model that does not warrant it, the
tab's contents are already visible to everyone in it, and settlement amounts and
addresses are public on-chain by construction.

What it means in practice: **treat the link like the tab itself**. The app says
so at the moment of sharing rather than leaving it to be discovered, and a link
should only go to the people who are in the tab. Obligation descriptions and
display names stay off-chain but ARE visible to anyone with the link.

## Trust on first use (TOFU) at member registration, known, accepted for v1

When you open an invite and first sync a ledger, your client accepts the member
set as presented by the (untrusted) relay. Each member in that set is
cryptographically proven to control their bound account, but the client cannot
verify:

- that the **human ↔ account** mapping is what you assume (you trust that the
  account that joined via Alice's invite is Alice, based on the out-of-band
  invite, not a verified identity), or
- that the presented member set is **complete**, a malicious relay could omit a
  legitimate member's join, or present its own (self-signed, real) account as a
  participant, at first sync before any cross-check exists.

**Threat model.** The relay cannot forge a member (that needs the account's
signature) and cannot attribute an entry to someone who did not sign it. It
*can* equivocate on the member set the very first time you sync, before you have
anything to compare against.

**Why this is acceptable for v1.** This is the standard bootstrapping trade-off
that SSH (`known_hosts`), Signal (safety numbers), and certificate transparency
all make. The money boundary is unaffected, TOFU on the member set cannot move
funds or forge an obligation. And Tally already ships the detection mechanisms
that catch equivocation after first use: head-hash comparison on every sync,
out-of-band member-list / head-hash comparison, on-chain settlement
reconciliation, and fork detection (PRD 5.5). A dishonest relay is caught, not
prevented.

**Tracked** as [`docs/issues/0001-tofu-member-registration.md`](docs/issues/0001-tofu-member-registration.md), to become a GitHub issue when the repository is pushed.

## Threat model per component

| Component | Can | Cannot |
| --- | --- | --- |
| **Relay** | Omit entries, reorder them, go down, read everything it stores | Forge an entry, alter one, attribute one to somebody who didn't sign it, or move money. It holds no keys |
| **Purse** | Sign log entries, and in auto-settle mode spend its own balance with no dialog | Spend more than it holds, pay anyone else's leg, or touch the account key. The balance is a hard protocol-level bound |
| **Nimiq Pay account key** | Authorise a purse, fund it, sign manual settlements | Be reached by Tally. The app only ever receives signatures, never the key |
| **A member** | Propose anything, accept or reject what names them, leave, settle their own legs | Accept on someone else's behalf, author a round entry with an unregistered purse, or make anyone pay |
| **Anyone with an invite link** | Read the whole tab | Write to it. Entries need a bound purse key |

## What is deliberately out of scope

- **Enforcement.** No VM means no escrow, no conditional release, no spending caps expressible on chain. Tally never promises enforcement, only evidence.
- **Preventing equivocation.** Detection only, on the certificate transparency model, described below.
- **Protecting the purse from its own device.** A compromised phone is a compromised purse. The bound is the balance.
- **Identity.** Tally proves an account controls a purse. It doesn't prove the human behind the account is who you think.
- **Privacy of amounts.** Settlement amounts and participant addresses are public on chain by construction. Obligation descriptions and display names stay off chain, but are visible to anyone with the invite link.

## Reporting

This is a competition entry on testnet. If you find a security issue, please
open a GitHub issue once the repository is public.
