// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IwaCircleCelo} from "../contracts/IwaCircleCelo.sol";
import {MockERC20} from "../contracts/test/MockERC20.sol";

contract SmokeTest is Test {
    function test_deploysAndReadsOrganizer() public {
        MockERC20 token = new MockERC20();
        address[] memory members = new address[](2);
        members[0] = address(0xA1);
        members[1] = address(0xB2);

        IwaCircleCelo circle = new IwaCircleCelo(address(token), 5_000_000, 100, 50, members);
        assertEq(circle.organizer(), address(this));
        assertEq(circle.memberCount(), 2);
    }
}
