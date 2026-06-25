# Iwa architecture (one page)

A saver makes ordinary contributions to a circle, and later proves their
reliability with a zero-knowledge proof that a Soroban contract verifies on
chain. No server sits in the middle. State lives on chain, and secrets stay on
the device.

## Flow

```
            +---------------------------+
            |        Frontend           |
            |  React app on the phone   |   What you tap. Join a circle,
            +---------------------------+   contribute, ask for a proof.
                         |
                         v
            +---------------------------+
            |     Savings contract      |   Soroban contract. Runs the ajo:
            |     (Soroban / Rust)      |   create, join, contribute,
            +---------------------------+   advance the round, collect the pot.
                         |
                         v
            +---------------------------+
            |   Contribution records    |   On-chain history of who paid and
            |   (on-chain state)        |   whether each payment was on time.
            +---------------------------+
                         |
                         v
            +---------------------------+
            |   Proof generator         |   Runs in the browser as WebAssembly.
            |   (browser / WASM)        |   Builds a BN254 Groth16 proof on the
            +---------------------------+   device. Secrets never leave.
                         |
                         v
            +---------------------------+
            |    Verifier contract      |   Soroban contract. Checks the proof
            |    (Soroban / Rust)       |   on chain using Stellar's native
            +---------------------------+   BN254 host functions.
                         |
                         v
            +---------------------------+
            |          Result           |   Valid or invalid. A lender sees only
            |   (Portable Trust         |   the verified claim. No amounts, no
            |    Credential)            |   circle, no identity.
            +---------------------------+
```

## What each box does

- **Frontend.** The phone app. The saver joins a circle, makes contributions,
  and requests a proof. It only talks to the two contract seams, never to a
  server.
- **Savings contract.** The rotating savings circle itself. It tracks members,
  rounds, contributions, and the pot, and decides whose turn it is to collect.
- **Contribution records.** The on-chain record of contributions, including
  whether each one was on time. This is the raw material the reputation proof is
  built from.
- **Proof generator.** Turns a member's private history into a BN254 Groth16
  proof of a statement like "completed at least X cycles, always on time, never
  defaulted." It runs on the device so the underlying data is never shared.
- **Verifier contract.** Reads the proof and confirms it is mathematically valid
  on chain. It learns only that the statement holds, nothing about the data
  behind it.
- **Result.** The Portable Trust Credential. A private, portable proof of
  reliability that reveals only the verified claim.

## Adapt from Nethermind versus build ourselves

We fork the Nethermind Stellar Private Payments reference and adapt the
cryptographic plumbing rather than building zero-knowledge from scratch.

- **Adapt from the reference:** the Soroban Groth16 verifier contract, the
  Circom and Groth16 proving setup on BN254, the browser WebAssembly proving
  pipeline, and the witness and key tooling.
- **Build ourselves:** the savings (ajo) contract and its contribution records,
  the reputation logic that counts completed cycles, on-time payments, and
  defaults, the reputation circuit that proves a threshold is met, and the Iwa
  frontend.

The reference proves private payments. Iwa repurposes the same machinery to
prove private reputation.

## Where the proof is made and where it is checked

- **Generated on the device.** The BN254 Groth16 proof is produced in the
  browser as WebAssembly, from data that stays local. This is the privacy
  promise, enforced by where the computation runs.
- **Verified on chain.** The Soroban verifier contract checks the proof using
  Stellar's native BN254 host functions. Verification is public and trustless,
  while the inputs remain private.

## On-chain versus on the device

- **On chain (Soroban storage):** the circle configuration, anonymous
  membership commitments, contribution records with their on-time flags, the
  Merkle root of memberships, and the set of spent nullifiers that stop
  double-claims. None of it names a person.
- **On the device (never on chain, never on a server):** the member's secret,
  their real identity, and the mapping from that identity to their on-chain
  commitments. This is what keeps the on-chain record anonymous.

Reputation numbers such as completed cycles, on-time count, and default count
are derived from the on-chain records. They are computed, not stored as a
profile, and they feed the proof rather than a public score.
