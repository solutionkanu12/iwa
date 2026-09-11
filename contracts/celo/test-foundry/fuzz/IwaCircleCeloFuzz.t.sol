// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IwaCircleCelo} from "../../contracts/IwaCircleCelo.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// @notice Focused, bounded fuzz tests for IwaCircleCelo's real parameter
/// domain (member count 2..32, timestamps around due/grace, member index,
/// callers, donation timing, multiple defaults). Complements the stateful
/// invariant suite in test-foundry/invariant/, which explores action
/// SEQUENCES; these tests target specific boundary VALUES directly.
contract IwaCircleCeloFuzzTest is Test {
    uint256 internal constant DEFAULT_AMOUNT = 5_000_000;
    uint64 internal constant DEFAULT_CADENCE = 1_000;
    uint64 internal constant DEFAULT_GRACE = 500;

    MockERC20 internal token;

    function setUp() public {
        token = new MockERC20();
    }

    function _members(uint8 n) internal pure returns (address[] memory members) {
        members = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            members[i] = address(uint160(0x20000 + i));
        }
    }

    function _deploy(uint8 n, uint256 amount, uint64 cadence, uint64 grace)
        internal
        returns (IwaCircleCelo circle, address[] memory members)
    {
        members = _members(n);
        circle = new IwaCircleCelo(address(token), amount, cadence, grace, members);
    }

    function _fundAndApprove(IwaCircleCelo circle, address member, uint256 amount) internal {
        token.mint(member, amount);
        vm.prank(member);
        token.approve(address(circle), amount);
    }

    // -----------------------------------------------------------------
    // Member count boundary: 2..32
    // -----------------------------------------------------------------

    function testFuzz_memberCountWithinBoundsDeploysCorrectly(uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        assertEq(circle.memberCount(), n);
        for (uint256 i = 0; i < n; i++) {
            assertEq(circle.memberAt(i), members[i]);
            assertEq(circle.scheduledMember(uint32(i + 1)), members[i]);
        }
    }

    function testFuzz_memberCountBelowMinimumReverts(uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 0, 1));
        address[] memory members = _members(n);
        vm.expectRevert(IwaCircleCelo.InvalidConfig.selector);
        new IwaCircleCelo(address(token), DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE, members);
    }

    function testFuzz_memberCountAboveMaximumReverts(uint8 extraRaw) public {
        uint256 n = uint256(bound(extraRaw, 1, 64)) + 32; // 33..96
        address[] memory members = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            members[i] = address(uint160(0x30000 + i));
        }
        vm.expectRevert(IwaCircleCelo.InvalidConfig.selector);
        new IwaCircleCelo(address(token), DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE, members);
    }

    // -----------------------------------------------------------------
    // Contribution amount boundary
    // -----------------------------------------------------------------

    function testFuzz_contributionAmountExactPotAtCollect(uint8 nRaw, uint256 amountRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        // Upper-bounded well under overflow: contributionAmount * memberCount
        // must itself fit in uint256, and members must be able to hold and
        // approve that many base units of a mock token.
        uint256 amount = bound(amountRaw, 1, type(uint256).max / 32);
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, amount, DEFAULT_CADENCE, DEFAULT_GRACE);

        for (uint256 i = 0; i < n; i++) {
            _fundAndApprove(circle, members[i], amount);
            vm.prank(members[i]);
            circle.contribute();
        }

        uint256 before = token.balanceOf(members[0]);
        circle.collect();
        assertEq(token.balanceOf(members[0]), before + amount * n, "pot must be exactly amount * memberCount");
    }

    function testFuzz_zeroContributionAmountRejectedAtConstruction(uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        address[] memory members = _members(n);
        vm.expectRevert(IwaCircleCelo.InvalidConfig.selector);
        new IwaCircleCelo(address(token), 0, DEFAULT_CADENCE, DEFAULT_GRACE, members);
    }

    /// A pathologically large contributionAmount that would overflow
    /// `contributionAmount * memberCount` must revert (Solidity 0.8 checked
    /// arithmetic) rather than silently wrap to a smaller, wrong pot.
    ///
    /// The overflow is actually hit earlier than collect(): summing n
    /// individual transfers of `amount` into the token's own balance
    /// mapping overflows at exactly the same threshold as the multiplication
    /// would, so the LAST contribute() in the round is where it reverts —
    /// arguably a stronger result (fails even before a pot is ever computed),
    /// not a weaker one. This test asserts fail-safe behavior at whichever
    /// point it actually occurs, rather than assuming it is collect().
    function testFuzz_potOverflowRevertsRatherThanWrapping(uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        uint256 amount = type(uint256).max / uint256(n) + 1; // guarantees overflow on n copies
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, amount, DEFAULT_CADENCE, DEFAULT_GRACE);
        for (uint256 i = 0; i < n; i++) {
            token.mint(members[i], amount);
            vm.prank(members[i]);
            token.approve(address(circle), amount);
        }
        for (uint256 i = 0; i < n - 1; i++) {
            vm.prank(members[i]);
            circle.contribute();
        }
        // The final contribution pushes the contract's own accumulated
        // balance past type(uint256).max: checked arithmetic panics rather
        // than wrapping to a small, wrong balance.
        vm.prank(members[n - 1]);
        vm.expectRevert();
        circle.contribute();
    }

    // -----------------------------------------------------------------
    // Cadence / grace / timestamp boundaries
    // -----------------------------------------------------------------

    function testFuzz_dueAndGraceBoundaryContributionOutcomes(uint64 cadenceRaw, uint64 graceRaw) public {
        uint64 cadence = uint64(bound(cadenceRaw, 1, 365 days));
        uint64 grace = uint64(bound(graceRaw, 0, 365 days));
        (IwaCircleCelo circle, address[] memory members) = _deploy(3, DEFAULT_AMOUNT, cadence, grace);
        _fundAndApprove(circle, members[0], DEFAULT_AMOUNT);
        _fundAndApprove(circle, members[1], DEFAULT_AMOUNT);
        _fundAndApprove(circle, members[2], DEFAULT_AMOUNT);

        // Exactly at dueAt(): OnTime (inclusive boundary).
        vm.warp(circle.dueAt());
        vm.prank(members[0]);
        circle.contribute();
        assertEq(
            uint8(circle.contributionStatus(1, members[0])),
            uint8(IwaCircleCelo.ContributionStatus.OnTime)
        );

        // Exactly at graceEndsAt(): LateWithinGrace if grace > 0 (still
        // inclusive), or WindowClosed if grace == 0 (dueAt == graceEndsAt,
        // already consumed by the on-time contribution above — use member 1
        // only when grace > 0 to keep this branch meaningful).
        if (grace > 0) {
            vm.warp(circle.graceEndsAt());
            vm.prank(members[1]);
            circle.contribute();
            assertEq(
                uint8(circle.contributionStatus(1, members[1])),
                uint8(IwaCircleCelo.ContributionStatus.LateWithinGrace)
            );
        }

        // One second past graceEndsAt(): WindowClosed, no matter the config.
        vm.warp(circle.graceEndsAt() + 1);
        vm.prank(members[2]);
        vm.expectRevert(IwaCircleCelo.WindowClosed.selector);
        circle.contribute();
    }

    function testFuzz_zeroGraceHasNoLateWindow(uint64 cadenceRaw, uint256 warpOffsetRaw) public {
        uint64 cadence = uint64(bound(cadenceRaw, 1, 365 days));
        (IwaCircleCelo circle, address[] memory members) = _deploy(2, DEFAULT_AMOUNT, cadence, 0);
        _fundAndApprove(circle, members[0], DEFAULT_AMOUNT);
        assertEq(circle.dueAt(), circle.graceEndsAt(), "zero grace must collapse due and grace-end");

        uint256 offset = bound(warpOffsetRaw, 1, 365 days);
        vm.warp(circle.dueAt() + offset);
        vm.prank(members[0]);
        vm.expectRevert(IwaCircleCelo.WindowClosed.selector);
        circle.contribute();
    }

    // -----------------------------------------------------------------
    // Member index / scheduledMember
    // -----------------------------------------------------------------

    function testFuzz_scheduledMemberMatchesConstructionOrder(uint8 nRaw, uint32 roundRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        uint32 round = uint32(bound(roundRaw, 1, n));
        assertEq(circle.scheduledMember(round), members[round - 1]);
    }

    function testFuzz_scheduledMemberOutOfRangeReverts(uint8 nRaw, uint32 roundRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle,) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        // round == 0, or round > n.
        uint32 round = roundRaw % 2 == 0 ? 0 : uint32(bound(roundRaw, n + 1, type(uint32).max));
        vm.expectRevert(IwaCircleCelo.WrongRound.selector);
        circle.scheduledMember(round);
    }

    // -----------------------------------------------------------------
    // Repeated callers / arbitrary non-members
    // -----------------------------------------------------------------

    function testFuzz_repeatedCallerCannotDoubleContribute(uint8 nRaw, uint8 memberIdxRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        uint8 idx = uint8(bound(memberIdxRaw, 0, n - 1));
        _fundAndApprove(circle, members[idx], DEFAULT_AMOUNT * 2);

        vm.startPrank(members[idx]);
        circle.contribute();
        vm.expectRevert(IwaCircleCelo.AlreadySatisfied.selector);
        circle.contribute();
        vm.stopPrank();
    }

    function testFuzz_arbitraryNonMemberCannotContribute(address caller, uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle,) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        vm.assume(!circle.isMember(caller));
        vm.assume(caller != address(0));

        vm.prank(caller);
        vm.expectRevert(IwaCircleCelo.NotMember.selector);
        circle.contribute();
    }

    function testFuzz_arbitraryCallerCanTriggerCollectButNeverReceivesFunds(address caller, uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        vm.assume(caller != members[0]);
        vm.assume(caller.code.length == 0); // avoid contracts without a fallback able to receive, not relevant here but keeps things simple
        for (uint256 i = 0; i < n; i++) {
            _fundAndApprove(circle, members[i], DEFAULT_AMOUNT);
            vm.prank(members[i]);
            circle.contribute();
        }

        uint256 callerBefore = token.balanceOf(caller);
        uint256 recipientBefore = token.balanceOf(members[0]);
        vm.prank(caller);
        circle.collect();
        assertEq(token.balanceOf(caller), callerBefore, "arbitrary caller must not receive the pot");
        assertEq(
            token.balanceOf(members[0]),
            recipientBefore + DEFAULT_AMOUNT * n,
            "scheduled member must receive the full pot regardless of caller"
        );
    }

    // -----------------------------------------------------------------
    // Donation timing
    // -----------------------------------------------------------------

    function testFuzz_donationBeforeAndAfterNeverInflatesPot(
        uint256 donationBeforeRaw,
        uint256 donationAfterRaw
    ) public {
        uint256 donationBefore = bound(donationBeforeRaw, 0, DEFAULT_AMOUNT * 1000);
        uint256 donationAfter = bound(donationAfterRaw, 0, DEFAULT_AMOUNT * 1000);
        (IwaCircleCelo circle, address[] memory members) = _deploy(3, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);

        token.mint(address(circle), donationBefore);
        for (uint256 i = 0; i < 3; i++) {
            _fundAndApprove(circle, members[i], DEFAULT_AMOUNT);
            vm.prank(members[i]);
            circle.contribute();
        }
        token.mint(address(circle), donationAfter);

        uint256 before = token.balanceOf(members[0]);
        circle.collect();
        assertEq(
            token.balanceOf(members[0]),
            before + DEFAULT_AMOUNT * 3,
            "donations before or after contributing must never change the pot"
        );
        assertEq(
            token.balanceOf(address(circle)),
            donationBefore + donationAfter,
            "only the untouched donations remain in the contract after collect"
        );
    }

    function testFuzz_donationDuringDeferredLockDoesNotInflateRecovery(uint256 donationRaw) public {
        uint256 donation = bound(donationRaw, 0, DEFAULT_AMOUNT * 1000);
        (IwaCircleCelo circle, address[] memory members) = _deploy(3, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        _fundAndApprove(circle, members[0], DEFAULT_AMOUNT);
        vm.prank(members[0]);
        circle.contribute();

        vm.warp(circle.graceEndsAt() + 1);
        circle.finalizeDefault(members[1]);
        circle.finalizeDefault(members[2]);
        token.mint(address(circle), donation);
        circle.lockPayoutAndAdvance();

        uint256 before = token.balanceOf(members[0]);
        vm.prank(members[0]);
        circle.recover(1);
        assertEq(token.balanceOf(members[0]), before + DEFAULT_AMOUNT, "recovery must equal exactly the own contribution");

        // The donation is never claimable by anyone through recover().
        vm.prank(members[1]);
        vm.expectRevert(IwaCircleCelo.NotRecoverable.selector);
        circle.recover(1);
    }

    // -----------------------------------------------------------------
    // Multiple defaults
    // -----------------------------------------------------------------

    function testFuzz_multipleDefaultsOnlyPayersRecover(uint8 nRaw, uint256 payMaskRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 16)); // keep the loop bounded for fuzz speed
        (IwaCircleCelo circle, address[] memory members) = _deploy(n, DEFAULT_AMOUNT, DEFAULT_CADENCE, DEFAULT_GRACE);
        uint256 payMask = bound(payMaskRaw, 0, (uint256(1) << n) - 1);

        uint256 payerCount;
        for (uint256 i = 0; i < n; i++) {
            if ((payMask >> i) & 1 == 1) {
                _fundAndApprove(circle, members[i], DEFAULT_AMOUNT);
                vm.prank(members[i]);
                circle.contribute();
                payerCount++;
            }
        }

        vm.warp(circle.graceEndsAt() + 1);
        for (uint256 i = 0; i < n; i++) {
            if ((payMask >> i) & 1 == 0) {
                circle.finalizeDefault(members[i]);
            }
        }

        if (payerCount == n) {
            // No default at all: lockPayoutAndAdvance must refuse (NoDeficit).
            vm.expectRevert(IwaCircleCelo.NoDeficit.selector);
            circle.lockPayoutAndAdvance();
            return;
        }

        circle.lockPayoutAndAdvance();
        assertEq(uint8(circle.payoutStatus(1)), uint8(IwaCircleCelo.PayoutStatus.DeferredLocked));

        uint256 totalRecovered;
        for (uint256 i = 0; i < n; i++) {
            bool paid = (payMask >> i) & 1 == 1;
            if (paid) {
                uint256 before = token.balanceOf(members[i]);
                vm.prank(members[i]);
                circle.recover(1);
                assertEq(token.balanceOf(members[i]), before + DEFAULT_AMOUNT);
                totalRecovered += DEFAULT_AMOUNT;

                vm.prank(members[i]);
                vm.expectRevert(IwaCircleCelo.AlreadyRecovered.selector);
                circle.recover(1);
            } else {
                vm.prank(members[i]);
                vm.expectRevert(IwaCircleCelo.NotRecoverable.selector);
                circle.recover(1);
            }
        }
        assertEq(totalRecovered, payerCount * DEFAULT_AMOUNT, "total recovered must equal exactly what payers put in");
        assertEq(token.balanceOf(address(circle)), 0, "the round's funds must be fully drained by recovery, nothing stuck");
    }
}
