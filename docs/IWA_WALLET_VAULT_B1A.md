# Iwa Wallet Vault — B1-A Technical Design

## Scope and security boundary

B1-A is a local, browser-only encrypted-vault foundation. It contains only
synthetic high-entropy test authorities. It does not generate, import, deploy,
or sign with a blockchain authority, and it sends no vault material to Iwa or
another service.

Iwa Account authentication grants product access only. It cannot unlock,
export, recover, or sign for an Iwa Wallet. Wallet authority requires both the
dedicated wallet passkey and the vault password. A six-digit PIN is a
rate-limited, process-memory convenience confirmation after that cold unlock;
it never grants wallet authority on its own.

## Record format and versioning

All persisted records are explicit JSON schema version `1`, validated before
use, and stored only in IndexedDB database `iwa-wallet-vault`, object store
`vaults`, keyed by an opaque `walletId`. The root wrapper contains an array of
independently authenticated authority-record envelopes; no plaintext authority
is part of the root record.

`WalletVaultRecordV1` stores only non-secret headers and encrypted bytes:

```text
format:       "iwa-wallet-vault"
version:      1
walletId:     opaque UUID-like identifier
recordType:   "root-wrap"
namespace:    "root"
createdAt / updatedAt
passwordKdf:  PBKDF2-HMAC-SHA-256, 600000 iterations, random 32-byte salt
passkey:      credential ID, RP ID, random 32-byte PRF input
authorityManifest: namespace-sorted SHA-256 digests of every authority envelope
recoveryGeneration: positive integer, initially 1 and rotated on recovery
cipher:       AES-256-GCM, fresh random 96-bit IV, 128-bit tag
ciphertext:   base64url encrypted 32-byte vault root secret
```

The ciphertext is authenticated with canonical UTF-8 associated data:

```text
IWA-WALLET-AAD-V1 | walletId | root-wrap | root | 1 |
created/updated timestamps | recovery generation | canonical authority manifest
```

Every future encrypted chain record uses the same immutable binding but with
its own `recordType` and namespace, for example `authority / starknet/mainnet`.
The root record authenticates the complete child-record set: each manifest entry
contains its namespace, record generation and SHA-256 digest of the canonical
encrypted envelope. Missing, extra, substituted, and namespace-modified child
records fail closed. The root AES-GCM ciphertext is exactly 48 bytes (a
32-byte VRS plus 16-byte tag), and other lengths are rejected before crypto.
The root record cannot decrypt if moved to another wallet, record type,
namespace, or version. Unknown versions, formats, fields, encodings, cipher
parameters, or record types fail closed; version migration must read an old
record, authenticate/decrypt it, write an independently authenticated new
record, then delete the old record in one IndexedDB transaction.

B1-A records produced before this local-only remediation do not contain the
manifest and are intentionally rejected rather than heuristically upgraded;
they contain only synthetic test material and were never released. Any future
released schema change must use a new on-disk version and an explicit migration
transaction; it must never silently reinterpret a prior envelope.

## Cryptographic construction

This phase uses only Web Crypto primitives:

1. Generate a random 32-byte vault root secret (VRS) with `crypto.getRandomValues`.
2. Derive a 256-bit password contribution using PBKDF2-HMAC-SHA-256 with a
   random 32-byte salt and **600,000 iterations**. This is the production
   minimum. Test policy is an explicitly injected, test-only reduced value and
   cannot be selected by a persisted record.
3. Obtain a 32-byte PRF output by a fresh user-verified assertion from the
   dedicated wallet credential, using its stored random PRF input.
4. Combine the two independent high-entropy contributions with HKDF-SHA-256
   (`IKM = password contribution || PRF output`, random per-vault HKDF salt,
   versioned purpose string as `info`) to produce a non-extractable AES-GCM
   wrapping key.
5. Encrypt/decrypt the VRS with AES-256-GCM, a fresh random 96-bit IV, 128-bit
   authentication tag, and the record-bound associated data above.
6. Encrypt future authority records independently with non-extractable
   AES-GCM keys derived from the in-memory VRS by HKDF with record-specific
   random salt and the same record-bound associated data.

PBKDF2 is the native, widely supported Web Crypto password KDF. The 600,000
iteration policy is OWASP's current PBKDF2-HMAC-SHA-256 recommendation. The
separate PRF contribution means an IndexedDB thief cannot verify password
guesses without also exercising the enrolled authenticator. We do not ship an
untuned WASM Argon2 implementation in B1-A; an Argon2id migration is a future
versioned decision, not a silent fallback.

Never reuse an AES-GCM IV with the same key. Passwords, PRF outputs, VRS,
derived key bytes, plaintext authority payloads, and recovery keys are never
serialized, logged, placed in URLs, or stored in browser web storage.

## Dedicated wallet passkey

The passkey is created separately from Iwa Account email/Google login. It is a
discoverable WebAuthn credential scoped to Iwa's RP ID, requiring
`userVerification: "required"`. The vault does not rely on a server to verify
an assertion: the passkey PRF output is a local key contribution, and no
WebAuthn assertion, PRF output, or authenticator private material reaches Iwa.

At enrollment, registration must report `prf.enabled: true`. At cold unlock,
the authentication output must carry the standards-defined 32-byte
`prf.results.first` value; authentication assertions do not carry `enabled`.
`getClientCapabilities()` is advisory: an explicit `"extension:prf": false`
is rejected, and an unknown result must still pass the actual ceremony. The
implementation checks the returned credential ID and PRF result length. A
browser/authenticator with no usable PRF result is unsupported
for Iwa Wallet creation, unlock, import, export, or signing. There is no
email-, Google-, session-, or password-only fallback.

PRF support is not universal, and creation-time PRF evaluation is optional.
Therefore creation verifies capability by immediately performing a
user-verified assertion; only that assertion's PRF result may make the vault
usable. The UI later needs an explicit compatibility screen rather than a
weaker mode. A future platform may sync a passkey, but Iwa neither assumes nor
depends on that behavior: a device with no local encrypted vault remains cold
until portable recovery is imported.

## Password and PIN roles

The wallet password remains 12–128 characters. It exists only in the caller's
input buffer while deriving the password contribution; it is neither persisted
nor used as an Iwa Account authenticator or reusable password hash. Its sole
role is a KDF input for the root-key wrapper.

The exactly-six-digit PIN exists only inside an already unlocked warm session.
Its process-memory verifier is bound to a random warm-session nonce and is
destroyed when the session locks. It has attempt limits and causes an immediate
lock on exhaustion. It cannot access IndexedDB, derive/unwrap the VRS, import
or export a recovery package, enroll a passkey, survive refresh/restart, or
authorize a signing operation. Future transaction signing must still request a
fresh wallet passkey assertion.

## Local state and lifetime

The cold state holds only validated encrypted records and public passkey
metadata. The public warm-session value is an opaque frozen capability with a
wallet ID only; VRS, authority plaintext, root envelope and PIN verifier remain
in module-private state and cannot be retrieved, enumerated, spread, or
JSON-serialized from that capability. Every unlock captures an operation epoch;
lock/logout advance it and invalidate stale asynchronous work before it may
publish a warm state. B1-A implements an idle timeout and explicit `lock()`;
the B1-B UI integration must call `lock()` on logout and page lifecycle events.
Timeout, explicit lock, and failed PIN-attempt limit clear every held byte with
`fill(0)` before references are dropped. JavaScript garbage collection cannot
guarantee physical zeroization; the design minimizes lifetime and forbids
plaintext persistence rather than claiming perfect memory erasure.

No vault code may use localStorage, sessionStorage, cookies, URL parameters,
service-worker caches, telemetry, or network APIs. IndexedDB contains only the
authenticated encrypted root wrapper and non-secret metadata. A failed
IndexedDB open, unavailable Web Crypto, unavailable WebAuthn PRF, malformed
record, or failed authentication locks and returns a generic safe error.

## Recovery package

Export creates an `iwa-wallet-recovery` version-1 envelope with a random
package ID, monotonically increasing package generation, independent random
96-bit IV, AES-256-GCM ciphertext, and record-bound recovery associated data.
The plaintext contains the VRS, synthetic future-authority payloads, public
descriptors, wallet ID, package ID, generation, and format version.

It is encrypted locally under a user-held random 32-byte recovery key encoded
for transport separately from the package. Iwa never stores the recovery key,
plaintext package, or a reconstructable secret. Import validates all envelope
and plaintext bindings, decrypts only in memory, makes the user enroll a new
PRF-capable wallet passkey and choose a new vault password, then rewraps the
same VRS locally. A successful import increments `recoveryGeneration` and
returns a replacement package with a distinct package ID; product UX must have
the user retain it and treat the old package as stale. A recovery package plus
its recovery key is intentionally a
portable bearer recovery credential and must be protected accordingly.

An entirely offline new device cannot cryptographically distinguish an old but
otherwise authentic recovery package from the newest one: that would require a
trusted online freshness authority, which conflicts with Iwa-disappearance
recovery. B1-A detects duplicate package IDs within an existing vault and
requires a new package after recovery; future authority-changing operations
must increment generation and export a replacement package. This is an
explicit residual risk, not a claim of global offline rollback prevention.

## Signing and browser threat boundary

No B1-A operation signs a transaction. B1-B/B2 signing must resolve an
immutable intent first, require a fresh passkey assertion, derive the exact
chain-record key, decrypt only that authority, sign, and lock/zero promptly.
An active Iwa web session is never a substitute.

At-rest compromise of IndexedDB, backend, or database does not yield a VRS.
An active same-origin XSS or malicious dependency can potentially invoke code
while a user is interacting with the browser and read JavaScript memory once a
wallet is unlocked; WebAuthn does not make an arbitrary compromised origin a
safe key-execution environment. B1-A limits exposure with cold-by-default
state, fresh user-verified PRF ceremonies, no persistent plaintext, short
warm sessions, and no broad signing API. Production wallet release additionally
requires CSP/Trusted Types/dependency controls, transaction-intent UI review,
and an XSS-focused review. Browser extensions are outside Iwa's cryptographic
trust boundary and receive the same limitation.

## Test and migration gates

Tests must prove authenticated encryption, AAD binding, wrong-password and
wrong-passkey rejection, malformed/version/ciphertext rejection, cross-wallet
and cross-namespace substitution rejection, local storage prohibition, PIN
restrictions, lifecycle locking, recovery roundtrip and corruption rejection,
duplicate recovery rejection, secret-safe logging, and request-boundary
prohibition. Parser corruption gets lightweight generated mutations locally;
larger fuzz campaigns move to disposable CI.

Sources: [WebAuthn Level 3 PRF extension](https://www.w3.org/TR/webauthn-3/#prf-extension),
[WebAuthn user verification](https://www.w3.org/TR/webauthn-3/#sctn-user-verification),
[Web Crypto derivation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey),
[AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams), and
[OWASP PBKDF2 work-factor guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
