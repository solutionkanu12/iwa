// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice S2 spike only. Proves the confidential deposit-weighted
///         winner-selection algorithm (spec section 7) is structurally
///         correct and measures its HCU cost. Not a product contract - no
///         deposits, no claims, no withdrawal, no ERC-7984 integration.
contract SpikeWeightedDraw is ZamaEthereumConfig {
    /// @dev Structural spike cap. The real MAX_PARTICIPANTS is decided by
    ///      this S2 measurement, not hardcoded here independently of it.
    uint16 public constant MAX_N = 16;

    /// @dev Sentinel for "no winner" (rollover case). type(uint16).max can
    ///      never collide with a real participant index (always < MAX_N).
    uint16 public constant NO_WINNER = type(uint16).max;

    euint64[] private _weight;
    euint16 private _winnerIndex;

    event WeightSet(uint16 index);
    event Drawn();

    function setWeight(externalEuint64 amount, bytes calldata inputProof) external {
        require(_weight.length < MAX_N, "cap reached");
        euint64 w = FHE.fromExternal(amount, inputProof);
        FHE.allowThis(w);
        _weight.push(w);
        emit WeightSet(uint16(_weight.length - 1));
    }

    function participantCount() external view returns (uint256) {
        return _weight.length;
    }

    /// @notice Production-shaped path: draws a real random ticket bounded by
    ///         a plaintext power-of-two, then runs the same walk as
    ///         drawWithTicket. Exists to measure the true HCU cost including
    ///         FHE.randEuint64 itself.
    function drawRandom(uint64 maxPoolTotalPowerOfTwo) external returns (euint16) {
        euint64 ticket = FHE.randEuint64(maxPoolTotalPowerOfTwo);
        return _runWalk(ticket);
    }

    /// @notice TEST-ONLY deterministic path. Supplies the encrypted ticket
    ///         directly instead of drawing it from FHE.randEuint64, so the
    ///         cumulative-selection algorithm's structural correctness
    ///         (interval boundaries, sentinel behavior, zero-weight
    ///         handling) can be verified without depending on
    ///         non-deterministic on-chain randomness.
    ///
    ///         MUST NOT be carried into the production pool contract -
    ///         the real draw() must always source its ticket from
    ///         FHE.randEuint64, never from caller-supplied input.
    function drawWithTicket(externalEuint64 ticketInput, bytes calldata inputProof)
        external
        returns (euint16)
    {
        euint64 ticket = FHE.fromExternal(ticketInput, inputProof);
        return _runWalk(ticket);
    }

    function _runWalk(euint64 ticket) private returns (euint16) {
        euint64 running = FHE.asEuint64(0);
        euint16 selected = FHE.asEuint16(NO_WINNER);

        uint256 n = _weight.length;
        for (uint16 i = 0; i < n; i++) {
            euint64 lower = running;
            running = FHE.add(running, _weight[i]);

            // in-range iff lower <= ticket < running. Disjoint by
            // construction (running only grows), so at most one iteration
            // can ever satisfy this for a given ticket.
            ebool inRange = FHE.and(FHE.le(lower, ticket), FHE.lt(ticket, running));
            selected = FHE.select(inRange, FHE.asEuint16(i), selected);
        }

        _winnerIndex = selected;
        FHE.allowThis(_winnerIndex);
        FHE.allow(_winnerIndex, msg.sender);

        emit Drawn();
        return selected;
    }

    function getWinnerIndex() external view returns (euint16) {
        return _winnerIndex;
    }
}
