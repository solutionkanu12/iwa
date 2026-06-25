# Iwa

**Your good name, proven and private.**

## What it is

Iwa is a digital ajo (a rotating savings circle) on Stellar that turns everyday
contributions into a Portable Trust Credential. The Portable Trust Credential is
a private, portable proof of reliability you can show to unlock loans and
services, without exposing your money, your circle, or your identity.

You save with people you trust, the way millions already do informally. Iwa
records that reliability on chain in a way only you can reveal, and only as much
as you choose.

## The problem

Billions of people are invisible to formal credit because their financial life
is informal. They save in circles, pay rent in cash, and support family in ways
no bureau ever sees. The reliability is real. The record is not.

The only mainstream fix today asks them to surrender everything. Hand a bureau
your full transaction history, your contacts, your identity, and hope to receive
a rating in return. That is a hard tradeoff. You are either private and
invisible, or visible and exposed.

Iwa removes the tradeoff. You keep your data. You share a proof.

## How the zero-knowledge proof is load-bearing

The whole product rests on one move. A member proves a statement like "I
completed at least X savings cycles, always paid on time, and never defaulted,"
and a Soroban smart contract verifies that statement is true. The contract
learns nothing else. No amounts, no circle, no identity, no payment dates.

Remove the zero-knowledge proof and the idea collapses into one of the two bad
options it was built to escape. Keep the data private and the reliability stays
invisible to a lender. Reveal the data so a lender can check it and the user is
exposed all over again. The proof is the only thing that lets reliability travel
without the data travelling with it. That is why this is a zero-knowledge
project and not a database with permissions.

## Tech

- **Smart contracts:** Soroban (Rust) on Stellar. A savings contract holds the
  circle state, and a verifier contract checks proofs on chain.
- **Zero-knowledge:** a Circom circuit producing Groth16 proofs on the BN254
  curve. On-chain verification uses Stellar's native BN254 host functions.
- **Proof generation in the browser:** proofs are generated on the user's
  device. Secrets never leave the device and never touch a server. This is the
  privacy promise, enforced by where the computation runs.
- **Network:** Stellar testnet.
- **Foundation:** adapted from Nethermind's Stellar Private Payments reference
  implementation of privacy pools (Circom circuits, Groth16, a Soroban verifier,
  and browser proving).

There is no traditional backend. State lives on chain in Soroban storage, and
secrets live on the user's device.

## Build status

This is an active hackathon build. Status is reported honestly below.

**Done**

- Toolchain proven end to end. A Soroban contract was built, deployed, and
  invoked on Stellar testnet.
- The Nethermind Stellar Private Payments reference fork builds from source.
- The reference end-to-end test passes. It generates real Groth16 proofs and
  verifies them through the Soroban contracts in process.
- Core architecture settled: BN254 curve, native Stellar BN254 verification, and
  Groth16 proving compiled to browser WebAssembly.

**In progress**

- The Iwa savings contract: create a circle, join, contribute, advance the
  round, and collect the pot, with seed-able contribution history.
- Reputation logic that computes completed cycles, on-time count, and default
  count for each member.
- The reputation circuit that proves a reliability threshold is met, adapted
  from the reference circuit shape.
- The frontend application, built separately against the same contract seam.

**Roadmap (stated, not yet built)**

- Multi-circle reputation aggregation across more than one savings circle.
- Lender and service integration so a verified proof unlocks real offers.
- Fiat and mobile-money on-ramps.
- Mainnet deployment after a security audit.

## Built for

Stellar Hacks: Real-World ZK, hosted on DoraHacks. Submission deadline is
June 29 2026, 12:00 PM PST. The brief calls for zero-knowledge proofs doing
real work on Stellar, which is exactly where Iwa places its weight.

## Links

- Project domain: [useiwa.xyz](https://useiwa.xyz)
