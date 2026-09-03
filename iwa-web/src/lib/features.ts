// lib/features.ts — what this deployment of Iwa can actually do.
//
// Two things are designed, tested and understood, and are not open yet. They
// are declared here rather than discovered by a person pressing a button: a
// control that fails once it is pressed teaches people the product is broken,
// and a control that is quietly missing teaches them it was never intended.
//
// So each one carries the reason it is not open, written for the person who
// wanted to use it, and every screen shows that same reason. When one becomes
// available, the flag flips here and nothing else has to be found and changed.
//
// The functions behind them still refuse. This is the explanation, not the
// safeguard: the seam throws either way, so a screen that forgot to check
// cannot spend a person's money or their time by accident.

export interface Capability {
  /** Whether this deployment can do it. */
  available: boolean;
  /** What it is, in the product's own words. */
  title: string;
  /** Why it is not open yet, and what is true in the meantime. */
  reason: string;
}

/**
 * Proving good standing to someone outside the circle.
 *
 * The claim model and the proving that runs on the member's own device both
 * exist. What is missing is the other half: something on this network able to
 * check a proof, which is what makes the claim worth anything to whoever
 * receives it. Until that is in place the proof could be produced and then
 * shown to nobody, which is time spent for nothing.
 */
export const CREDENTIAL_VERIFICATION: Capability = {
  available: false,
  title: "Portable Trust Credential",
  reason:
    "Proving your reliability to someone outside a circle is not open in this version. Your record is still being kept, privately, and it is what a proof will be built from when sharing opens.",
};

/**
 * Collecting the pot on your turn.
 *
 * The settlement path exists and is covered by the contract tests. What cannot
 * be done yet is authorising it from a browser wallet: the authorisation has to
 * commit to an identifier that only exists once the wallet has already
 * assembled the transaction, so the signature cannot be produced in time. It is
 * left closed rather than half working.
 */
export const POT_COLLECTION: Capability = {
  available: false,
  title: "Collecting the pot",
  reason:
    "Collecting is not open in this version. Your turn and your place in the order are recorded, and nothing about them changes while this is being finished. When it does open, only you will be able to release your own round, using the same wallet you joined with, so keeping access to that wallet is what keeps your turn claimable.",
};

/** Every declared capability, for tests and for anything that lists them. */
export const CAPABILITIES: Capability[] = [CREDENTIAL_VERIFICATION, POT_COLLECTION];
