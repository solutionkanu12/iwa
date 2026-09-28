# Iwa Wallet Recovery Format V1

## Status and scope

This is the local implementation specification for B1-C. It is not a public
release format or a substitute for the future independent recovery application.
It carries only the B1-A synthetic-authority test fixtures today. It contains
no deployed Starknet, EVM, Solana, STRK20 viewing, or settlement authority.

A package is portable: a future standalone Iwa Wallet recovery PWA or CLI can
restore it without the Iwa frontend, backend, database, session, or any Iwa
infrastructure credential. Iwa never receives the package or recovery code.

## User-held artifacts

Recovery requires both independent artifacts:

1. An encrypted `.iwa` JSON package.
2. A separately held recovery code, exactly `iwa-recovery-v1.` followed by a
   43-character base64url encoding of 32 random bytes.

The code is 256 bits from `crypto.getRandomValues`. It is not a mnemonic, seed
phrase, vault password, Iwa Account password, PIN, or WebAuthn credential. It
is not placed in the package, its filename, IndexedDB, a URL, an Iwa request,
or telemetry. The UI permits an explicit copy action only and clears its
temporary reveal after verification, route exit, or five minutes.

## Outer package envelope

The file is UTF-8 JSON with exactly these properties and no unknown fields:

```text
format       "iwa-wallet-recovery"
version      1
walletId     opaque Iwa Wallet identifier
packageId    random opaque package identifier
generation   positive safe integer
createdAt    ISO-8601 timestamp
cipher:
  algorithm  "AES-256-GCM"
  iv         base64url of exactly 12 random bytes
  ciphertext base64url authenticated ciphertext, maximum 256 KiB
```

The browser limits selected package text to 384 KiB before JSON parsing. All
identifiers reject separators, line breaks, empty values, and oversized input.
The outer envelope, cipher shape, encodings, timestamps, version, and maximum
ciphertext length are validated before decryption. Unsupported versions and
unknown fields fail closed.

The download name is `iwa-wallet-recovery-<first-8-wallet-id>-g<generation>.iwa`.
It contains no recovery code, password, PIN, root secret, or full wallet ID.
The browser creates a short-lived object URL for the encrypted package only
and revokes it after the user-initiated download click.

## Encryption and authentication

The recovery code bytes are imported as a non-extractable Web Crypto AES-GCM
256-bit key. Recovery V1 deliberately does not apply a password KDF because the
recovery code is already a uniformly random 256-bit secret, not a human
password. The package uses a fresh 96-bit AES-GCM IV and 128-bit tag.

Associated data is UTF-8 encoded exactly as:

```text
IWA-WALLET-RECOVERY-AAD-V1|walletId|packageId|generation|1|createdAt
```

Changing the wallet ID, package ID, generation, timestamp, IV, ciphertext, or
any authenticated payload bytes makes opening fail. The code copies incoming
key bytes into short-lived buffers and wipes them after use where JavaScript
permits. This reduces exposure but cannot promise physical memory zeroization
by a garbage-collected browser runtime.

## Encrypted payload

The decrypted V1 JSON payload has exactly:

```text
format              "iwa-wallet-recovery-payload"
version             1
walletId            must match outer envelope
packageId           must match outer envelope
generation          must match outer envelope
rootSecret          base64url, exactly 32 bytes
authorities[]:
  id                unique bounded authority identifier
  material          base64url, exactly 32 bytes in the current B1 fixture
publicDescriptors[]:
  namespace         bounded non-secret namespace
  publicId          bounded non-secret descriptor
```

The encrypted payload's exact duplicate-free authority list is the V1 recovery
manifest. AES-GCM authenticates it. On import, Iwa Wallet rebuilds the local
root wrapper's SHA-256 authority manifest from that list, then binds the root
manifest, recovery generation, wallet ID, record type, and namespace into the
root wrapper's authenticated associated data.

V1 has an explicit envelope and authority-list boundary so later authority
types can be added through reviewed, versioned authority-record evolution
rather than a new recovery architecture. B1-C does not claim that a real chain
authority format has been approved or populated yet.

## Validation order and failure rule

1. Enforce file text and ciphertext bounds.
2. Parse JSON and require exact outer keys and V1 version.
3. Validate encodings, identifiers, timestamp, generation, cipher algorithm,
   IV length, and ciphertext bound.
4. Parse the separate recovery code exactly. Do not normalize case, spacing,
   grouping, or an alternative alphabet.
5. Decrypt with AES-GCM and the exact associated data.
6. Require exact payload keys and equality with the outer wallet ID, package
   ID, generation, and version.
7. Validate root length, each authority, duplicate authority IDs, and public
   descriptors.
8. If online freshness metadata is available, compare the authenticated
   generation with the server's non-secret latest generation before import.
9. On a new device, require a new user-verified PRF-capable wallet passkey,
   a new 12 to 128 character local vault password, and a new device-only PIN.
10. Rewrap the same root locally, rebuild the authority manifest, increment
    generation, and issue a replacement encrypted package.

Any failure returns a generic local recovery failure, creates no new container,
and does not silently overwrite a healthy or different local wallet. A corrupt
local record requires a future explicit reviewed replacement flow.

## Generation and freshness

The initial verified package is generation 1. A successful recovery imports
generation N, creates local generation N+1, and produces a replacement package
at N+1. The Iwa backend may retain only `{ recoveryStatus, recoveryGeneration
}` linked to its opaque wallet ID. It cannot open a package or reconstruct any
secret.

When the backend is reachable, a package older than its recorded generation is
refused before local import. If Iwa is unavailable, offline recovery remains
possible from the package plus code alone. Offline recovery cannot prove that a
valid bearer package is the newest one; that is an inherent limitation, not a
claim of rollback prevention. When connectivity returns, a generation conflict
must be resolved safely before relying on server-coordinated onboarding state.

## Standalone implementation requirements

A future standalone tool must implement the preceding schema, bounds, strict
parsing, AES-GCM associated data, and root-manifest rebuild exactly. It must
not call Iwa services, derive a recovery key from email or a PIN, import an old
passkey private credential, or write secrets to localStorage, sessionStorage,
cookies, URLs, logs, clipboard without explicit user action, telemetry, or
unencrypted persistent storage.

The standalone tool is not implemented or released by B1-C. Its real-chain
authority adapters are a later reviewed phase.
