// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

import {IwaCircleCelo} from "../../contracts/IwaCircleCelo.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// @notice Randomized action driver for IwaCircleCelo invariant testing.
///
/// Every action is bounded to the contract's real domain (member count,
/// round numbers, timestamps) rather than raw uint256 noise, and every
/// action is wrapped in try/catch so an expected revert simply ends that
/// call without halting the run. Where the contract's own promise can be
/// checked immediately (payout destination, no-double-recovery), the
/// handler asserts it right there, in addition to the ghost totals the
/// invariant test itself checks against token.balanceOf.
contract IwaCircleCeloHandler is CommonBase, StdCheats, StdUtils {
    IwaCircleCelo public immutable circle;
    MockERC20 public immutable token;
    uint8 public immutable memberCount;

    address[] public members;
    address public immutable organizer;
    address public immutable outsiderA;
    address public immutable outsiderB;

    // --- Ghost accounting: things not directly observable via a view call ---
    uint256 public ghost_totalContributed;
    uint256 public ghost_totalPaidOut;
    uint256 public ghost_totalRecovered;
    uint256 public ghost_totalDonated;

    // --- Ghost call counters, for reporting only ---
    uint256 public calls_contribute;
    uint256 public calls_contributeReverted;
    uint256 public calls_collect;
    uint256 public calls_collectReverted;
    uint256 public calls_lockPayoutAndAdvance;
    uint256 public calls_lockPayoutAndAdvanceReverted;
    uint256 public calls_finalizeDefault;
    uint256 public calls_recover;
    uint256 public calls_recoverReverted;
    uint256 public calls_donate;
    uint256 public calls_warp;
    uint256 public calls_unauthorizedContribute;
    uint256 public calls_unauthorizedRecover;

    // --- Monotonic-round tracking, asserted inline after every call ---
    uint32 public ghost_lastObservedRound;
    bool public ghost_wasCompleted;

    constructor(IwaCircleCelo circle_, MockERC20 token_, address[] memory members_, address organizer_) {
        circle = circle_;
        token = token_;
        members = members_;
        memberCount = circle_.memberCount();
        organizer = organizer_;
        outsiderA = address(0xBEEF01);
        outsiderB = address(0xBEEF02);
        ghost_lastObservedRound = circle_.currentRound();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _member(uint256 seed) internal view returns (address) {
        return members[bound(seed, 0, memberCount - 1)];
    }

    /// A wide pool including members, the organizer, and two outsiders — for
    /// actions that are supposed to be permissionless and whose destination
    /// must not depend on who called.
    function _anyCaller(uint256 seed) internal view returns (address) {
        uint256 pool = memberCount + 3; // members + organizer + 2 outsiders
        uint256 idx = bound(seed, 0, pool - 1);
        if (idx < memberCount) return members[idx];
        if (idx == memberCount) return organizer;
        if (idx == memberCount + 1) return outsiderA;
        return outsiderB;
    }

    /// Asserts the round never rewinds and Completed is terminal, right
    /// after every state-changing call — not deferred to a periodic
    /// invariant check, so a violation is caught at the exact call that
    /// caused it.
    function _checkMonotonic() internal {
        uint32 nowRound = circle.currentRound();
        require(nowRound >= ghost_lastObservedRound, "ROUND REWOUND");
        if (ghost_wasCompleted) {
            require(circle.status() == IwaCircleCelo.CircleStatus.Completed, "REVIVED COMPLETED CIRCLE");
        }
        ghost_lastObservedRound = nowRound;
        if (circle.status() == IwaCircleCelo.CircleStatus.Completed) {
            ghost_wasCompleted = true;
        }
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    function contribute(uint256 memberSeed) external {
        address member = _member(memberSeed);
        calls_contribute++;

        uint256 before = token.balanceOf(address(circle));
        vm.prank(member);
        try circle.contribute() {
            uint256 delta = token.balanceOf(address(circle)) - before;
            require(delta == circle.contributionAmount(), "CONTRIBUTE DELTA MISMATCH");
            ghost_totalContributed += circle.contributionAmount();
        } catch {
            calls_contributeReverted++;
        }
        _checkMonotonic();
    }

    /// An explicit adversarial variant: a non-member (organizer or outsider)
    /// attempting to contribute must always revert and must never move
    /// tokens or ghost state.
    function unauthorizedContribute(uint256 callerSeed) external {
        uint256 idx = bound(callerSeed, 0, 2);
        address caller = idx == 0 ? organizer : (idx == 1 ? outsiderA : outsiderB);
        if (circle.isMember(caller)) return; // organizer might coincide with a member in some setups
        calls_unauthorizedContribute++;

        uint256 before = token.balanceOf(address(circle));
        vm.prank(caller);
        try circle.contribute() {
            revert("NON-MEMBER CONTRIBUTED");
        } catch {
            require(token.balanceOf(address(circle)) == before, "BALANCE CHANGED ON REVERTED CONTRIBUTE");
        }
    }

    function warpToDueBoundary() external {
        calls_warp++;
        uint64 target = circle.dueAt();
        if (target > block.timestamp) vm.warp(target);
    }

    function warpIntoGrace(uint256 offsetSeed) external {
        calls_warp++;
        uint64 due = circle.dueAt();
        uint64 graceEnd = circle.graceEndsAt();
        if (graceEnd <= due) return; // zero-grace configuration: no interior to warp into
        uint256 span = graceEnd - due;
        uint64 target = due + uint64(bound(offsetSeed, 1, span));
        if (target > block.timestamp) vm.warp(target);
    }

    function warpPastGrace(uint256 offsetSeed) external {
        calls_warp++;
        uint64 target = circle.graceEndsAt() + 1 + uint64(bound(offsetSeed, 0, 1_000));
        if (target > block.timestamp) vm.warp(target);
    }

    function warpBy(uint256 secondsSeed) external {
        calls_warp++;
        uint256 delta = bound(secondsSeed, 0, uint256(circle.cadenceSeconds()) * 3 + 1);
        vm.warp(block.timestamp + delta);
    }

    function finalizeDefault(uint256 memberSeed) external {
        address member = _member(memberSeed);
        calls_finalizeDefault++;
        try circle.finalizeDefault(member) {
            // no token movement; nothing to reconcile against ghost totals.
        } catch {
            // Inactive / NotMember / HistoryImmutable / GraceNotExpired: all fine.
        }
        _checkMonotonic();
    }

    function collect(uint256 callerSeed) external {
        address caller = _anyCaller(callerSeed);
        calls_collect++;

        uint32 round = circle.currentRound();
        address expectedRecipient = circle.scheduledMember(round);
        uint256 recipientBefore = token.balanceOf(expectedRecipient);
        uint256 callerBefore = token.balanceOf(caller);
        uint256 pot = circle.contributionAmount() * uint256(circle.memberCount());

        vm.prank(caller);
        try circle.collect() {
            require(
                token.balanceOf(expectedRecipient) == recipientBefore + pot,
                "COLLECT DID NOT PAY SCHEDULED MEMBER THE FULL POT"
            );
            if (caller != expectedRecipient) {
                require(token.balanceOf(caller) == callerBefore, "CALLER RECEIVED FUNDS IT WAS NOT OWED");
            }
            ghost_totalPaidOut += pot;
        } catch {
            calls_collectReverted++;
        }
        _checkMonotonic();
    }

    function lockPayoutAndAdvance(uint256 callerSeed) external {
        address caller = _anyCaller(callerSeed);
        calls_lockPayoutAndAdvance++;

        vm.prank(caller);
        try circle.lockPayoutAndAdvance() {
            // No token movement; funds only ever leave via collect()/recover().
        } catch {
            calls_lockPayoutAndAdvanceReverted++;
        }
        _checkMonotonic();
    }

    function recover(uint256 memberSeed, uint256 roundSeed) external {
        address member = _member(memberSeed);
        uint32 round = uint32(bound(roundSeed, 1, memberCount));
        calls_recover++;

        // Ground truth from the contract's own views, captured before the
        // call: what SHOULD gate a successful recover().
        IwaCircleCelo.PayoutStatus payoutBefore = circle.payoutStatus(round);
        IwaCircleCelo.ContributionStatus statusBefore = circle.contributionStatus(round, member);
        bool eligibleBefore = payoutBefore == IwaCircleCelo.PayoutStatus.DeferredLocked
            && (statusBefore == IwaCircleCelo.ContributionStatus.OnTime
                || statusBefore == IwaCircleCelo.ContributionStatus.LateWithinGrace);

        uint256 memberBefore = token.balanceOf(member);
        uint256 amount = circle.contributionAmount();

        vm.prank(member);
        try circle.recover(round) {
            require(eligibleBefore, "RECOVER SUCCEEDED WITHOUT MEETING THE CONTRACT'S OWN GATING CONDITIONS");
            require(token.balanceOf(member) == memberBefore + amount, "RECOVER PAID THE WRONG AMOUNT");
            ghost_totalRecovered += amount;
        } catch {
            calls_recoverReverted++;
        }
    }

    /// A member with no legitimate claim (never paid, or a round that was
    /// never locked) must never recover anything.
    function unauthorizedRecover(uint256 memberSeed, uint256 roundSeed) external {
        address member = _member(memberSeed);
        uint32 round = uint32(bound(roundSeed, 1, memberCount));
        IwaCircleCelo.PayoutStatus payoutBefore = circle.payoutStatus(round);
        IwaCircleCelo.ContributionStatus statusBefore = circle.contributionStatus(round, member);
        bool eligible = payoutBefore == IwaCircleCelo.PayoutStatus.DeferredLocked
            && (statusBefore == IwaCircleCelo.ContributionStatus.OnTime
                || statusBefore == IwaCircleCelo.ContributionStatus.LateWithinGrace);
        if (eligible) return; // this call is only interesting when recovery should be refused

        calls_unauthorizedRecover++;
        uint256 before = token.balanceOf(member);
        vm.prank(member);
        try circle.recover(round) {
            revert("IN-ELIGIBLE RECOVER SUCCEEDED");
        } catch {
            require(token.balanceOf(member) == before, "BALANCE CHANGED ON REVERTED RECOVER");
        }
    }

    /// Simulates an accidental/direct token transfer straight to the
    /// circle, bypassing contribute() entirely.
    function donate(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 0, circle.contributionAmount() * 10);
        calls_donate++;
        token.mint(address(circle), amount);
        ghost_totalDonated += amount;
    }

    // ---------------------------------------------------------------------
    // Reporting
    // ---------------------------------------------------------------------

    function ghostNetOwed() external view returns (uint256) {
        return ghost_totalContributed + ghost_totalDonated - ghost_totalPaidOut - ghost_totalRecovered;
    }
}
