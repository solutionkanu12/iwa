// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IwaCircleCeloInvariantsBase} from "./IwaCircleCeloInvariantsBase.t.sol";

/// A typical circle size: enough rounds for multiple defaults, locks, and
/// recoveries to interleave meaningfully within the configured depth.
contract IwaCircleCeloInvariantsTypicalTest is IwaCircleCeloInvariantsBase {
    function _memberCount() internal pure override returns (uint8) {
        return 6;
    }
}
