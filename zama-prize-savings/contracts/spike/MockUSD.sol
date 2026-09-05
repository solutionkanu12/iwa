// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice S3 spike only. Plaintext test ERC-20 with an open mint, standing in
///         for the deposit asset that users wrap into the confidential
///         ERC-7984 token. 6 decimals so the wrapper's rate() is 1.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "MockUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}