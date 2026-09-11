// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockERC20} from "./MockERC20.sol";
import {IwaCircleCelo} from "../IwaCircleCelo.sol";

contract ReentrantToken is MockERC20 {
    IwaCircleCelo public circle;
    bool public attackContribute;
    bool public attackCollect;

    function setCircle(address circle_) external {
        circle = IwaCircleCelo(circle_);
    }

    function armContribute() external {
        attackContribute = true;
    }

    function armCollect() external {
        attackCollect = true;
    }

    function _move(address from, address to, uint256 amount) internal override {
        super._move(from, to, amount);
        if (attackContribute && address(circle) != address(0)) {
            attackContribute = false;
            circle.contribute();
        }
        if (attackCollect && address(circle) != address(0)) {
            attackCollect = false;
            circle.collect();
        }
    }
}
