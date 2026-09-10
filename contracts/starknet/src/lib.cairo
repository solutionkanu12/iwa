// IWA Cairo library. Circle membership/contributions/payouts are later slices.

pub mod iwa_circle;
pub mod iwa_errors;
pub mod iwa_events;
pub mod iwa_strk20_helper;
pub mod iwa_types;

// V2 private pot collection (Candidate P: precommitted private destination
// note). Additive only — V1 modules above are untouched and still deployed.
pub mod iwa_circle_v2;
pub mod iwa_events_v2;
pub mod iwa_strk20_helper_v2;
pub mod iwa_types_v2;

#[cfg(feature: 'test_erc20')]
pub mod test_erc20;

// Isolated, feature-gated V2 private-payout capability spike (candidate P:
// precommitted destination note). Not V1, not production, not deployed.
#[cfg(feature: 'v2_precommit_spike')]
pub mod v2_precommit_spike;
