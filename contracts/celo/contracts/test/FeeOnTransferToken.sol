// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockERC20} from "./MockERC20.sol";

contract FeeOnTransferToken is MockERC20 {
    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        if (fee == 0 && amount > 0) fee = 1;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
    }
}
