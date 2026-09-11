// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IwaCircleCeloInvariantsBase} from "./IwaCircleCeloInvariantsBase.t.sol";

/// Minimum member count (2): the tightest schedule — round 2 is always the
/// last round, so completion and the collect()-vs-lock() boundary happen
/// almost immediately.
contract IwaCircleCeloInvariantsMinTest is IwaCircleCeloInvariantsBase {
    function _memberCount() internal pure override returns (uint8) {
        return 2;
    }
}
