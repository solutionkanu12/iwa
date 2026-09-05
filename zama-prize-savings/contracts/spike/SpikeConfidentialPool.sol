// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @notice S3 spike only. Proves the pool side of the confidential deposit
///         path (spec section 6 / correction C1): pulls from the ERC-7984
///         token and credits the ACTUAL returned encrypted amount, never the
///         requested amount, so unbacked pool shares are impossible.
///         Not a product contract - no state machine, no MAX_POOL_TOTAL cap,
///         no prize, no claim, no withdrawal.
contract SpikeConfidentialPool is ZamaEthereumConfig {
    IERC7984 public immutable token;

    mapping(address => euint64) private _credited;

    /// @dev Deliberately carries no value - only who acted.
    event Pulled(address indexed user);

    constructor(IERC7984 token_) {
        token = token_;
    }

    /// @notice Pulls an encrypted amount of cMockUSD from the caller and
    ///         credits the amount actually transferred.
    ///
    ///         The caller must have granted this pool operator permission on
    ///         the confidential token (setOperator(pool, until)).
    ///
    ///         The pinned OZ ERC7984 transfers are all-or-nothing: it moves
    ///         the full requested amount when the balance covers it, and 0
    ///         when it does not (FHESafeMath.tryDecrease -> select). Either
    ///         way, ONLY the returned value is credited - requesting more than
    ///         one holds mints nothing (C1, the fund-draining exploit test).
    function pullFrom(externalEuint64 requested, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(requested, inputProof);

        // The token contract must be allowed to operate on the requested
        // amount handle (documented OZ/Zama operator pattern).
        FHE.allowTransient(amount, address(token));

        euint64 actual = token.confidentialTransferFrom(msg.sender, address(this), amount);

        // FHESafeMath.tryAdd safely absorbs the first (uninitialized) credit
        // and guards the encrypted addition against overflow.
        (, euint64 updated) = FHESafeMath.tryAdd(_credited[msg.sender], actual);
        _credited[msg.sender] = updated;

        // ACL re-grant on every write (spec 5.1 / correction C3): the pool
        // must reuse the stored handle in LATER transactions, and the user
        // must decrypt it.
        FHE.allowThis(updated);
        FHE.allow(updated, msg.sender);

        emit Pulled(msg.sender);
    }

    function creditedBalanceOf(address user) external view returns (euint64) {
        return _credited[user];
    }
}