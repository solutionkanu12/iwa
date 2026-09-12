// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IwaPrizeSavings} from "../IwaPrizeSavings.sol";

/// @notice TEST-ONLY harness for P3 draw tests. Drives the SAME internal
///         _runDraw weighted walk as the production IwaPrizeSavings.draw(),
///         but with an encrypted caller-supplied ticket so interval logic can
///         be asserted deterministically.
///
///         NEVER deployed, NEVER part of the production ABI surface: it is
///         not imported by any deployment script, and the production
///         contract's own ABI (asserted by the test suite) exposes no
///         deterministic ticket path.
contract TestDrawHarness is IwaPrizeSavings {
    constructor(IERC7984 token_) IwaPrizeSavings(token_) {}

    /// @dev Same state + authorization rules as the production draw(), with
    ///      the ticket supplied instead of drawn from FHE.randEuint64.
    ///      Drives the CURRENT round, exactly as production draw() does,
    ///      including the automatic advance to the next round.
    function drawWithTicket(externalEuint64 ticketInput, bytes calldata inputProof) external {
        uint256 roundId = currentRoundId;
        Round storage r = _rounds[roundId];
        require(r.state == RoundState.Locked, "not locked");
        require(
            msg.sender == owner() || block.timestamp >= r.lockTimestamp + DRAW_TIMEOUT,
            "not authorized"
        );
        _runDraw(roundId, FHE.fromExternal(ticketInput, inputProof));
    }
}