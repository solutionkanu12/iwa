// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice S1 spike only. Proves the encrypted round-trip and that ACL grants
///         survive across transaction boundaries. Not a product contract.
contract SpikeRoundTrip is ZamaEthereumConfig {
    mapping(address => euint64) private _stored;

    /// @dev Deliberately carries no value - only who acted.
    event Stored(address indexed user);
    event Touched(address indexed user);

    function store(externalEuint64 inputHandle, bytes calldata inputProof) external {
        euint64 value = FHE.fromExternal(inputHandle, inputProof);
        _stored[msg.sender] = value;

        FHE.allowThis(value);
        FHE.allow(value, msg.sender);

        emit Stored(msg.sender);
    }

    /// @notice Re-uses the caller's stored ciphertext in a LATER transaction.
    ///         Only succeeds if allowThis persisted the contract's permission,
    ///         so this is the actual test of cross-transaction ACL persistence.
    function touch() external {
        euint64 updated = FHE.add(_stored[msg.sender], FHE.asEuint64(0));
        _stored[msg.sender] = updated;

        FHE.allowThis(updated);
        FHE.allow(updated, msg.sender);

        emit Touched(msg.sender);
    }

    function getHandle(address user) external view returns (euint64) {
        return _stored[user];
    }
}
