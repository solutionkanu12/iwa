use iwa::iwa_errors;
use iwa::iwa_events::CircleCreated;
use iwa::iwa_types::{
    CircleConfig, CircleStatus, ContributionObligation, ContributionStatus, Member, PayoutState,
    PayoutStatus, SupportedAsset,
};

#[test]
fn allowlisted_assets_are_usdc_and_strk() {
    assert(SupportedAsset::Usdc != SupportedAsset::Strk, 'distinct assets');
}

#[test]
fn contribution_status_has_locked_reliability_states() {
    assert(ContributionStatus::Pending != ContributionStatus::OnTime, 'pending != on_time');
    assert(ContributionStatus::OnTime != ContributionStatus::LateWithinGrace, 'on_time != late');
    assert(
        ContributionStatus::LateWithinGrace != ContributionStatus::MissedDefault, 'late != missed',
    );
}

#[test]
fn circle_and_payout_status_unions_exist() {
    assert(CircleStatus::Created != CircleStatus::Active, 'created != active');
    assert(CircleStatus::PausedForNewActions != CircleStatus::Completed, 'paused != completed');
    assert(PayoutStatus::Scheduled != PayoutStatus::DeferredLocked, 'scheduled != deferred');
    assert(PayoutStatus::Paid != PayoutStatus::Recovered, 'paid != recovered');
}

#[test]
fn domain_structs_use_commitments_not_addresses() {
    let config = CircleConfig {
        asset: SupportedAsset::Usdc,
        contribution_amount: 5_000_000,
        cadence_seconds: 604_800,
        grace_period_seconds: 86_400,
        member_limit: 3,
    };
    let member = Member { circle_id: 1, member_ref: 'm1', slot: 0 };
    let obligation = ContributionObligation {
        circle_id: 1,
        round: 1,
        member_ref: member.member_ref,
        asset: config.asset,
        required_amount: config.contribution_amount,
        due_at: 1_000,
        grace_ends_at: 2_000,
        status: ContributionStatus::Pending,
    };
    let payout = PayoutState {
        circle_id: 1,
        round: 1,
        scheduled_member_ref: member.member_ref,
        status: PayoutStatus::DeferredLocked,
    };

    assert(config.member_limit == 3, 'limit');
    assert(obligation.asset == config.asset, 'obligation asset');
    assert(obligation.required_amount == config.contribution_amount, 'obligation amount');
    assert(obligation.status == ContributionStatus::Pending, 'pending');
    assert(payout.status == PayoutStatus::DeferredLocked, 'deferred');
}

#[test]
fn error_codes_are_distinct() {
    assert(iwa_errors::CIRCLE_NOT_FOUND != iwa_errors::ALREADY_PAID, 'distinct errors');
    assert(iwa_errors::UNSUPPORTED_ASSET != iwa_errors::ORDER_LOCKED, 'asset != order');
    assert(iwa_errors::PAYOUT_LOCKED != iwa_errors::UNAUTHORIZED, 'payout != auth');
}

#[test]
fn circle_created_event_payload_compiles() {
    let event = CircleCreated {
        circle_id: 0, asset: SupportedAsset::Strk, contribution_amount: 1, member_limit: 2,
    };
    assert(event.circle_id == 0, 'id');
    assert(event.asset == SupportedAsset::Strk, 'asset');
}

