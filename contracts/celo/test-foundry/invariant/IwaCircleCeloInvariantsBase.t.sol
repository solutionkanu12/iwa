// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IwaCircleCelo} from "../../contracts/IwaCircleCelo.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";
import {IwaCircleCeloHandler} from "../handlers/IwaCircleCeloHandler.sol";

/// @notice Shared invariant checks against a randomized action handler.
/// Subclasses fix a member count so the state machine's depth is
/// tractable while still covering the boundary sizes requested (2, a
/// typical size, and the 32-member maximum).
abstract contract IwaCircleCeloInvariantsBase is Test {
    uint256 internal constant AMOUNT = 5_000_000;
    uint64 internal constant CADENCE = 1_000;
    uint64 internal constant GRACE = 500;

    IwaCircleCelo internal circle;
    MockERC20 internal token;
    IwaCircleCeloHandler internal handler;
    address internal organizer = address(0xC1CE0);

    address[] internal initialMembers;
    address internal initialToken;
    address internal initialOrganizer;
    uint256 internal initialContributionAmount;
    uint64 internal initialCadence;
    uint64 internal initialGrace;
    uint8 internal initialMemberCount;

    function _memberCount() internal virtual returns (uint8);

    function setUp() public {
        uint8 n = _memberCount();
        token = new MockERC20();

        address[] memory members = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            members[i] = address(uint160(0x10000 + i));
        }

        vm.prank(organizer);
        circle = new IwaCircleCelo(address(token), AMOUNT, CADENCE, GRACE, members);

        handler = new IwaCircleCeloHandler(circle, token, members, organizer);

        // Fund every member generously and approve the circle once, up
        // front: contribute() itself is what's under test, not ERC20
        // plumbing, and every member needs enough for every round.
        for (uint256 i = 0; i < n; i++) {
            token.mint(members[i], AMOUNT * (uint256(n) + 5));
            vm.prank(members[i]);
            token.approve(address(circle), type(uint256).max);
        }

        initialMembers = members;
        initialToken = address(token);
        initialOrganizer = circle.organizer();
        initialContributionAmount = circle.contributionAmount();
        initialCadence = circle.cadenceSeconds();
        initialGrace = circle.gracePeriodSeconds();
        initialMemberCount = circle.memberCount();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.contribute.selector;
        selectors[1] = handler.unauthorizedContribute.selector;
        selectors[2] = handler.warpToDueBoundary.selector;
        selectors[3] = handler.warpIntoGrace.selector;
        selectors[4] = handler.warpPastGrace.selector;
        selectors[5] = handler.warpBy.selector;
        selectors[6] = handler.finalizeDefault.selector;
        selectors[7] = handler.collect.selector;
        selectors[8] = handler.lockPayoutAndAdvance.selector;
        selectors[9] = handler.recover.selector;
        selectors[10] = handler.unauthorizedRecover.selector;
        selectors[11] = handler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // -----------------------------------------------------------------
    // 1. Accounting
    // -----------------------------------------------------------------

    /// contract balance == unresolved contributions + untouched donations.
    /// Donations never inflate what's actually owed to anyone; they simply
    /// sit in the balance, accounted for on both sides of the equation.
    function invariant_accountingEquation() public view {
        assertEq(
            token.balanceOf(address(circle)),
            handler.ghostNetOwed(),
            "balance != (contributed + donated - paidOut - recovered)"
        );
    }

    // -----------------------------------------------------------------
    // 2 & 5. No overpayment / recovery uniqueness (also asserted inline in
    // the handler, immediately after each successful call — these restate
    // the aggregate form so a violation is caught two ways).
    // -----------------------------------------------------------------

    function invariant_noOverpayment() public view {
        // Every dollar that ever left the contract came from a contribution
        // or a donation; nothing was minted from nothing.
        assertLe(
            handler.ghost_totalPaidOut() + handler.ghost_totalRecovered(),
            handler.ghost_totalContributed() + handler.ghost_totalDonated(),
            "paid out + recovered exceeds contributed + donated"
        );
    }

    // -----------------------------------------------------------------
    // 6. Round progression
    // -----------------------------------------------------------------

    function invariant_roundNeverExceedsMemberCount() public view {
        assertLe(circle.currentRound(), circle.memberCount(), "currentRound exceeded memberCount");
    }

    function invariant_roundNeverBelowOne() public view {
        assertGe(circle.currentRound(), 1, "currentRound fell below 1");
    }

    // -----------------------------------------------------------------
    // 7. Completion terminality
    // -----------------------------------------------------------------

    function invariant_completedStopsAllProgressExceptRecover() public {
        if (circle.status() != IwaCircleCelo.CircleStatus.Completed) return;

        uint32 round = circle.currentRound();
        vm.prank(initialMembers[0]);
        vm.expectRevert(IwaCircleCelo.Inactive.selector);
        circle.contribute();

        vm.expectRevert(IwaCircleCelo.Inactive.selector);
        circle.collect();

        vm.expectRevert(IwaCircleCelo.Inactive.selector);
        circle.lockPayoutAndAdvance();

        vm.expectRevert(IwaCircleCelo.Inactive.selector);
        circle.finalizeDefault(initialMembers[0]);

        // currentRound is frozen at memberCount once Completed.
        assertEq(round, circle.memberCount(), "round did not settle at memberCount on completion");
    }

    // -----------------------------------------------------------------
    // 9. Organizer privilege
    // -----------------------------------------------------------------

    function invariant_organizerHasNoExtraPower() public {
        // The organizer in this harness is deliberately not a member. If it
        // is not a member, it must be refused exactly like any outsider.
        if (circle.isMember(initialOrganizer)) return;
        if (circle.status() != IwaCircleCelo.CircleStatus.Active) return;

        vm.prank(initialOrganizer);
        vm.expectRevert(IwaCircleCelo.NotMember.selector);
        circle.contribute();
    }

    // -----------------------------------------------------------------
    // 10. Immutable configuration
    // -----------------------------------------------------------------

    function invariant_configurationNeverChanges() public view {
        assertEq(address(circle.token()), initialToken, "token changed");
        assertEq(circle.organizer(), initialOrganizer, "organizer changed");
        assertEq(circle.contributionAmount(), initialContributionAmount, "contributionAmount changed");
        assertEq(circle.cadenceSeconds(), initialCadence, "cadenceSeconds changed");
        assertEq(circle.gracePeriodSeconds(), initialGrace, "gracePeriodSeconds changed");
        assertEq(circle.memberCount(), initialMemberCount, "memberCount changed");
        for (uint256 i = 0; i < initialMembers.length; i++) {
            assertEq(circle.memberAt(i), initialMembers[i], "member order changed");
        }
    }

    function invariant_scheduledRecipientsNeverChange() public view {
        for (uint32 r = 1; r <= initialMemberCount; r++) {
            assertEq(circle.scheduledMember(r), initialMembers[r - 1], "scheduled recipient changed");
        }
    }

    // -----------------------------------------------------------------
    // Debug summary, printed on every run for visibility into what the
    // fuzzer actually exercised.
    // -----------------------------------------------------------------

    function invariant_callSummary() public view {
        // No assertion: this exists purely so `-vv` output shows coverage.
        handler.calls_contribute();
    }
}
