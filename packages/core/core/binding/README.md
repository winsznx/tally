# core/binding

The purse-to-account binding attestation — PRD 3.1. This is what makes every
accountability claim in Tally real.

## The invariant this module protects

**A purse (session) key proves nothing on its own — the binding proves which
Nimiq Pay account that purse speaks for.** Every log entry is signed by a purse
key; without an attestation tying that purse to a real account, anyone could
author entries under any address. The binding closes that gap, and it is
required in **both** purse mode and manual mode, because the purse's log-signing
role (Role 1) exists in both — only its funds-custody role (Role 2) is
purse-mode-only.

## What the account signs

At setup the account holder signs this message with Nimiq Pay's `nimiq.sign()`
(PRD 3.1):

```
Tally purse binding v1
account: <account, user-friendly IBAN>
purse: <purse public key, hex>
```

`nimiq.sign()` applies the **Nimiq Signed Message** scheme, verified against
`core-rs-albatross` (`wallet/src/wallet_account.rs`):

```
digest    = sha256( "\x16Nimiq Signed Message:\n" + decimalByteLength(msg) + msg )
signature = Ed25519_sign(accountKey, digest)     // signs the 32-byte digest
```

`verifyBindingAttestation` reconstructs the message **from the entry's own purse
public key**, verifies the signature against the account public key over that
digest, and confirms the account public key derives the claimed account address.
Because the message is rebuilt from the entry's purse key, a binding lifted from
elsewhere (naming a different purse) simply fails to verify.

## How the log uses it

`LEDGER_OPEN` and `MEMBER_JOIN` carry `accountPublicKey` and `bindingSignature`
in their payload (the account address is the entry's `authorAddress`). Replay
**rejects** a registration whose attestation does not verify — the member never
registers, and the entry is recorded in `state.ignored`. After registration, a
single shared guard requires every later entry from that account to carry the
registered purse key, so a purse-key swap is rejected uniformly across all entry
types.

## Deviations from the prompt's field list, flagged

- The prompt lists `{ accountAddress, pursePublicKey, bindingSignature }`. This
  implementation carries **`accountPublicKey`** in the payload too — an Ed25519
  signature cannot be verified without the public key, and the account address
  is derived from it. `accountAddress` is the entry's `authorAddress`;
  `pursePublicKey` is the entry envelope field.
- The binding is intentionally **ledger-independent** (the PRD message names no
  ledger), consistent with PRD 3.1's single cross-device purse. Cross-ledger
  membership forgery is still prevented: the message is verified against the
  entry's purse key, and the entry is purse-signed, so a binding cannot be
  reused to register a purse its owner never authorised. See
  `binding.test.ts` and the "binding attestation at registration" tests in
  `../log/log.test.ts`.

## Note on the two account signatures

The signature verified here (the **attestation**, over a message naming the
purse) is distinct from the signature that **derives** the purse in `core/tx`
(over the fixed string, kept secret because its hash is the purse seed). Whether
those collapse into one Nimiq Pay dialog at setup is a UX decision for the app
phase; this module only defines and verifies the attestation.
