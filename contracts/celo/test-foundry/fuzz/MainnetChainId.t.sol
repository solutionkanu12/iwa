// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IwaCircleCelo} from "../../contracts/IwaCircleCelo.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// @notice Isolates the chainId=42220 token-pinning behavior for the
/// Foundry layer, without weakening it: `vm.chainId` sets the EVM's real
/// chainid (the same value the contract's own `block.chainid == 42220`
/// check reads), and `vm.etch` places a working ERC20 mock's bytecode at
/// the exact CNGN_MAINNET address so the pinned constant itself is
/// exercised — not a stand-in address. The dedicated Hardhat suite
/// (test-mainnet-chainid/) already covers the constructor's accept/reject
/// branches exhaustively; this file adds fuzzed contribution amounts under
/// that exact pinned configuration for extra depth, isolated to this file
/// so it never affects the default-chainid suites above.
contract MainnetChainIdFuzzTest is Test {
    function _members(uint8 n) internal pure returns (address[] memory members) {
        members = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            members[i] = address(uint160(0x50000 + i));
        }
    }

    function testFuzz_pinnedCngnCircleFunctionsNormallyUnderMainnetChainId(uint8 nRaw, uint256 amountRaw) public {
        vm.chainId(42220);
        address cngn = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f; // IwaCircleCelo.CNGN_MAINNET

        MockERC20 mock = new MockERC20();
        vm.etch(cngn, address(mock).code);
        MockERC20 token = MockERC20(cngn);

        uint8 n = uint8(bound(nRaw, 2, 32));
        uint256 amount = bound(amountRaw, 1, type(uint256).max / 64);
        address[] memory members = _members(n);

        IwaCircleCelo circle = new IwaCircleCelo(cngn, amount, 1_000, 500, members);
        assertEq(address(circle.token()), cngn);

        for (uint256 i = 0; i < n; i++) {
            token.mint(members[i], amount);
            vm.prank(members[i]);
            token.approve(address(circle), amount);
            vm.prank(members[i]);
            circle.contribute();
        }

        uint256 before = token.balanceOf(members[0]);
        circle.collect();
        assertEq(token.balanceOf(members[0]), before + amount * n);
    }

    function testFuzz_nonCanonicalTokenStillRejectedUnderMainnetChainId(address wrongToken) public {
        vm.chainId(42220);
        vm.assume(wrongToken != 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f);
        vm.assume(wrongToken != address(0));

        address[] memory members = _members(2);
        vm.expectRevert(IwaCircleCelo.UnsupportedToken.selector);
        new IwaCircleCelo(wrongToken, 5_000_000, 1_000, 500, members);
    }
}
