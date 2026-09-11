// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IwaCircleCeloInvariantsBase} from "./IwaCircleCeloInvariantsBase.t.sol";

/// MAX_MEMBERS (32): the widest payout order and the largest _allPaid /
/// _anyDefault / _allSettled loop bound the contract ever runs in
/// production.
contract IwaCircleCeloInvariantsMaxTest is IwaCircleCeloInvariantsBase {
    function _memberCount() internal pure override returns (uint8) {
        return 32;
    }
}
