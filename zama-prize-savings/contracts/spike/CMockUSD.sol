// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice S3 spike only. The required concrete subclass of OpenZeppelin's
///         abstract ERC7984ERC20Wrapper: wraps plaintext MockUSD into the
///         confidential cMockUSD token. No bespoke confidential token -
///         transfer/ACL semantics come entirely from the pinned
///         openzeppelin-confidential-contracts 0.5.3 package. It also inherits
///         ZamaEthereumConfig so its FHE operations resolve the Zama
///         coprocessor (every FHE-capable contract needs that wiring).
contract CMockUSD is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 underlying_) ERC7984ERC20Wrapper(underlying_) ERC7984("Confidential Mock USD", "cMockUSD", "") {}
}