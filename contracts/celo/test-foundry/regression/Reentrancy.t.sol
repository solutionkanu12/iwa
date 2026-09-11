// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IwaCircleCelo} from "../../contracts/IwaCircleCelo.sol";
import {ReentrantToken} from "../../contracts/test/ReentrantToken.sol";

/// @notice Fuzzed reentrancy regression coverage, reusing the existing
/// ReentrantToken mock from the Hardhat suite. The chainId=42220 path pins
/// the token to canonical cNGN, so this attack is not reachable in
/// production — this suite exists to prove the ReentrancyGuard itself holds
/// across a randomized member count and contribution amount, not to model a
/// realistic mainnet token.
contract ReentrancyFuzzTest is Test {
    function _members(uint8 n) internal pure returns (address[] memory members) {
        members = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            members[i] = address(uint160(0x40000 + i));
        }
    }

    function testFuzz_reentrantContributeAlwaysReverts(uint8 nRaw, uint256 amountRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        uint256 amount = bound(amountRaw, 1, type(uint256).max / 64);

        ReentrantToken token = new ReentrantToken();
        address[] memory members = _members(n);
        IwaCircleCelo circle = new IwaCircleCelo(address(token), amount, 1_000, 500, members);
        token.setCircle(address(circle));

        token.mint(members[0], amount * 4);
        vm.prank(members[0]);
        token.approve(address(circle), amount * 4);
        token.armContribute();

        vm.prank(members[0]);
        vm.expectRevert();
        circle.contribute();

        // A revert rolls back every state change made during it, including
        // `_contribution[1][members[0]]` being set before the reentrant
        // sub-call: the obligation must be exactly as untouched as if
        // contribute() had never been called at all.
        assertEq(
            uint8(circle.contributionStatus(1, members[0])),
            uint8(IwaCircleCelo.ContributionStatus.Pending)
        );
        assertEq(token.balanceOf(address(circle)), 0, "no balance may move on a reverted reentrant attempt");
    }

    function testFuzz_reentrantCollectAlwaysReverts(uint8 nRaw, uint256 amountRaw) public {
        uint8 n = uint8(bound(nRaw, 2, 32));
        uint256 amount = bound(amountRaw, 1, type(uint256).max / 64);

        ReentrantToken token = new ReentrantToken();
        address[] memory members = _members(n);
        IwaCircleCelo circle = new IwaCircleCelo(address(token), amount, 1_000, 500, members);
        token.setCircle(address(circle));

        for (uint256 i = 0; i < n; i++) {
            token.mint(members[i], amount * 4);
            vm.prank(members[i]);
            token.approve(address(circle), amount * 4);
            vm.prank(members[i]);
            circle.contribute();
        }

        token.armCollect();
        vm.expectRevert();
        circle.collect();

        // State must be exactly as it was before the attack attempt: round
        // 1 still Scheduled, not silently advanced or double-paid.
        assertEq(uint8(circle.payoutStatus(1)), uint8(IwaCircleCelo.PayoutStatus.Scheduled));
        assertEq(circle.currentRound(), 1);
    }
}
