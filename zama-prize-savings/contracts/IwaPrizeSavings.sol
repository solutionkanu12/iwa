// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, euint16, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @notice IwaPrizeSavings - P1 pool core (approved spec sections 4-6, 10).
///         State machine (Open/Locked/Drawn/Claimable), confidential deposit,
///         confidential requested withdraw, withdrawAll liveness hatch.
///         Prize funding, draw and claim arrive in P2-P4; this contract
///         carries none of that code yet.
///
///         Accounting rule (C1, mandatory): ONLY the actual returned ERC-7984
///         transfer amount is credited or debited - never the requested
///         amount. The pinned OZ ERC7984 transfers are all-or-nothing, so a
///         shortfall deposit transfers 0 and credits 0; the user retries.
///
///         ACL rule (C3, mandatory): every encrypted handle written to storage
///         is re-authorized in the same transaction - FHE.allowThis(handle)
///         (contract reuse in later transactions) and FHE.allow(handle, user)
///         (user decryption).
contract IwaPrizeSavings is ZamaEthereumConfig, Ownable {
    enum RoundState {
        Open,
        Locked,
        Drawn,
        Claimable
    }

    /// @dev S2-measured hard cap (see decision.md). Never raised without a
    ///      new HCU measurement.
    uint256 public immutable MAX_PARTICIPANTS;

    /// @dev Plaintext power-of-two bound (2^10 = 1024, the S2-measured bound)
    ///      for deposit headroom and later for bounded FHE randomness
    ///      (spec 7.1). Participant deposit weight never exceeds this value.
    uint256 public immutable MAX_POOL_TOTAL;

    /// @dev Permissionless-draw delay after lock (C6). Approved 2026-09-05:
    ///      Sepolia bounty-MVP value only, MUST be reviewed before any
    ///      production deployment (decision.md).
    uint256 public constant DRAW_TIMEOUT = 900;

    /// @dev Rollover sentinel (spec 7.3): 65535 can never collide with a
    ///      valid participant index (always < MAX_PARTICIPANTS).
    uint16 private constant NO_WINNER = type(uint16).max;

    IERC7984 public immutable token;

    RoundState public roundState;
    uint256 public lockTimestamp;

    address[] public participants;
    uint256 public participantCount;

    /// @dev 1-based participant index; 0 means never registered.
    mapping(address => uint16) public participantIndex;
    mapping(address => bool) public isParticipant;

    /// @dev Per-user claim flag (single-round equivalent of the spec's
    ///      claimed[roundId][user]). Never a global per-round flag: one
    ///      user's claim must not block another's.
    mapping(address => bool) private _claimed;

    mapping(address => euint64) private _credited;

    /// @dev Participant deposit total = draw weight. NEVER merged with the
    ///      prize reserve: the prize must not inflate winning weight
    ///      (spec 5, 7.4, decision.md).
    euint64 private _confidentialTotal;

    /// @dev Confidential prize reserve (C2). Irrevocable: no function in this
    ///      contract reduces, redirects, or recovers it. ACL: allowThis only -
    ///      the contract alone operates on it (P4 claim reads it via
    ///      FHE.select); nobody, including the owner, can decrypt it.
    euint64 private _prizeReserve;

    /// @dev Round's random ticket and the encrypted euint16 winner index.
    ///      Both stay confidential: allowThis only, no user/owner decrypt
    ///      access, no public disclosure (C4 decision: ticket confidential
    ///      for the bounty MVP).
    euint64 private _drawTicket;
    euint16 private _winnerIndex;

    /// @dev Deliberately carry no value - only who acted.
    event Deposited(address indexed user);
    event Withdrawn(address indexed user);
    event WithdrawnAll(address indexed user);
    event ParticipantRegistered(address indexed user, uint16 index);
    event RoundLocked(uint256 lockTimestamp);
    event PrizeFunded(address indexed funder);
    event Drawn();
    event Claimed(address indexed user);

    constructor(IERC7984 token_) Ownable(msg.sender) {
        token = token_;
        MAX_PARTICIPANTS = 16;
        MAX_POOL_TOTAL = 1024;
    }

    /// @notice Confidential deposit. Pulls cMockUSD from the caller and
    ///         credits ONLY the actual returned amount.
    ///
    ///         Participant registration (spec 6.6): once per wallet, on the
    ///         first deposit request, enforced in plaintext against
    ///         MAX_PARTICIPANTS. A single wallet can never occupy more than
    ///         one slot, so repeated zero-transfer attempts cannot consume
    ///         the cap. A first deposit that transfers 0 still registers the
    ///         wallet once; such a zero-weight participant can never be
    ///         selected in the draw (S2-verified).
    function deposit(externalEuint64 amount, bytes calldata inputProof) external {
        require(roundState == RoundState.Open, "not open");

        if (!isParticipant[msg.sender]) {
            require(participants.length < MAX_PARTICIPANTS, "pool full");
            _registerParticipant(msg.sender);
        }

        euint64 requested = FHE.fromExternal(amount, inputProof);

        // Headroom clamp (spec 6.4): acceptedRequest = min(requested,
        // MAX_POOL_TOTAL - participantTotal). Encrypted all the way - no
        // plaintext branch, no decryption of the total. trySub fails closed
        // to 0 if the total ever exceeded the bound.
        (, euint64 headroom) = FHESafeMath.trySub(FHE.asEuint64(uint64(MAX_POOL_TOTAL)), _confidentialTotal);
        euint64 toPull = FHE.min(requested, headroom);

        // The token contract must be allowed to operate on the requested
        // amount handle (documented OZ/Zama operator pattern).
        FHE.allowTransient(toPull, address(token));

        euint64 actual = token.confidentialTransferFrom(msg.sender, address(this), toPull);

        // Credit ONLY the actual returned value (C1).
        (, euint64 newBalance) = FHESafeMath.tryAdd(_credited[msg.sender], actual);
        _credited[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        (, euint64 newTotal) = FHESafeMath.tryAdd(_confidentialTotal, actual);
        _confidentialTotal = newTotal;
        FHE.allowThis(newTotal);

        emit Deposited(msg.sender);
    }

    /// @notice Owner-only. Freezes participation. Draw/claim arrive later.
    function lockRound() external onlyOwner {
        require(roundState == RoundState.Open, "not open");
        roundState = RoundState.Locked;
        lockTimestamp = block.timestamp;
        emit RoundLocked(lockTimestamp);
    }

    /// @notice Owner-only. Funds the confidential prize reserve by pulling
    ///         cMockUSD and crediting ONLY the actual returned amount (C1/C2).
    ///
    ///         The prize is IRREVOCABLE: once transferred in, no function in
    ///         this contract reduces, redirects, recovers, or sweeps it. The
    ///         only legitimate future movement is the approved P4 claim flow.
    ///         Allowed only while the round is Open (plan P2: funding after
    ///         Locked reverts).
    ///
    ///         The reserve is a separate encrypted value from the participant
    ///         total - it never counts as participant draw weight.
    function fundPrize(externalEuint64 amount, bytes calldata inputProof) external onlyOwner {
        require(roundState == RoundState.Open, "not open");

        euint64 requested = FHE.fromExternal(amount, inputProof);

        FHE.allowTransient(requested, address(token));

        euint64 actual = token.confidentialTransferFrom(msg.sender, address(this), requested);

        (, euint64 newReserve) = FHESafeMath.tryAdd(_prizeReserve, actual);
        _prizeReserve = newReserve;

        // Contract retains permission to operate on the reserve in later
        // transactions (P4 claim reads it via FHE.select). No user or owner
        // decryption access is granted.
        FHE.allowThis(newReserve);

        emit PrizeFunded(msg.sender);
    }

    /// @notice Confidential withdrawal of a requested amount. Available in
    ///         every round state (spec 10). The request is clamped with
    ///         FHE.min to the caller's credited balance - an encrypted
    ///         <= balance transfer, no plaintext branch - and only the ACTUAL
    ///         returned transfer is debited, so accounting can never go
    ///         negative.
    function withdraw(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 credited = _credited[msg.sender];

        // Plaintext check on the handle, not the value: a wallet that never
        // deposited (zero handle) has nothing to withdraw. Reveals nothing -
        // participation is public by design.
        if (!FHE.isInitialized(credited)) {
            emit Withdrawn(msg.sender);
            return;
        }

        euint64 requested = FHE.fromExternal(amount, inputProof);
        euint64 toSend = FHE.min(requested, credited);

        // The token contract must be allowed to operate on the outgoing
        // handle (documented OZ/Zama operator pattern).
        FHE.allowTransient(toSend, address(token));

        euint64 actual = token.confidentialTransfer(msg.sender, toSend);

        // Debit ONLY the actual returned value (C1).
        (, euint64 newBalance) = FHESafeMath.trySub(credited, actual);
        _credited[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        (, euint64 newTotal) = FHESafeMath.trySub(_confidentialTotal, actual);
        _confidentialTotal = newTotal;
        FHE.allowThis(newTotal);

        emit Withdrawn(msg.sender);
    }

    /// @notice Liveness hatch (C5): withdraws the caller's full credited
    ///         balance with NO encrypted input and NO input proof, so users
    ///         can always exit even if the relayer/SDK encrypted-input
    ///         infrastructure is unavailable. Same accounting rules as
    ///         withdraw(). Never reverts for an empty balance.
    function withdrawAll() external {
        euint64 credited = _credited[msg.sender];

        if (!FHE.isInitialized(credited)) {
            emit WithdrawnAll(msg.sender);
            return;
        }

        FHE.allowTransient(credited, address(token));

        euint64 actual = token.confidentialTransfer(msg.sender, credited);

        (, euint64 newBalance) = FHESafeMath.trySub(credited, actual);
        _credited[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        (, euint64 newTotal) = FHESafeMath.trySub(_confidentialTotal, actual);
        _confidentialTotal = newTotal;
        FHE.allowThis(newTotal);

        emit WithdrawnAll(msg.sender);
    }

    /// @notice Draws the round (spec 7). Owner may draw immediately after
    ///         lockRound(); anyone may draw at or after
    ///         lockTimestamp + DRAW_TIMEOUT (C6, anti-stranding). Exactly once
    ///         per round, enforced by the state machine: Locked -> Drawn.
    ///
    ///         Weighted selection is the S2-proven walk over LIVE participant
    ///         balances (no snapshot, B5) with a plaintext power-of-two
    ///         ticket bound; no modulo/rebias, no encrypted bound, no re-draw.
    ///         Moves no tokens: the prize reserve and all balances are
    ///         untouched. The winner index stays encrypted; nobody, including
    ///         the owner, is granted decryption access.
    function draw() external {
        require(roundState == RoundState.Locked, "not locked");
        require(
            msg.sender == owner() || block.timestamp >= lockTimestamp + DRAW_TIMEOUT,
            "not authorized"
        );
        euint64 ticket = FHE.randEuint64(uint64(MAX_POOL_TOTAL));
        _runDraw(ticket);
    }

    /// @dev The S2-proven cumulative weighted walk (spec 7.2). Shared by the
    ///      production draw() and the test-only harness so deterministic
    ///      tests exercise the exact production path.
    function _runDraw(euint64 ticket) internal {
        euint64 running = FHE.asEuint64(0);
        euint16 selected = FHE.asEuint16(NO_WINNER);

        uint256 n = participants.length;
        for (uint16 i = 0; i < n; i++) {
            euint64 lower = running;
            running = FHE.add(running, _credited[participants[i]]);

            // in-range iff lower <= ticket < running. Intervals are disjoint
            // by construction (running only grows), so at most one iteration
            // can satisfy this for a given ticket.
            ebool inRange = FHE.and(FHE.le(lower, ticket), FHE.lt(ticket, running));
            selected = FHE.select(inRange, FHE.asEuint16(i), selected);
        }

        _winnerIndex = selected;
        FHE.allowThis(_winnerIndex);

        _drawTicket = ticket;
        FHE.allowThis(_drawTicket);

        roundState = RoundState.Drawn;
        emit Drawn();
    }

    /// @notice The user's encrypted credited balance handle. ACL-gated:
    ///         decryptable only by the user (and usable only by this
    ///         contract).
    function confidentialBalanceOf(address user) external view returns (euint64) {
        return _credited[user];
    }

    function confidentialTotal() external view returns (euint64) {
        return _confidentialTotal;
    }

    /// @notice Encrypted prize reserve handle. Opaque to everyone: no
    ///         allowance grants decryption access to any address.
    function prizeReserve() external view returns (euint64) {
        return _prizeReserve;
    }

    /// @notice Encrypted euint16 winner index handle (opaque to everyone).
    function winnerIndex() external view returns (euint16) {
        return _winnerIndex;
    }

    /// @notice The round's encrypted draw ticket handle (opaque to everyone).
    function drawTicket() external view returns (euint64) {
        return _drawTicket;
    }

    /// @notice Encrypted prize credit (spec 9, B3). Pull action: any
    ///         participant claims, a winner is credited the encrypted prize,
    ///         a non-winner is credited encrypted zero - never a revert on an
    ///         encrypted condition, and winner identity stays private.
    ///
    ///         State: runs in Drawn or Claimable; the FIRST claim performs the
    ///         one-time Drawn -> Claimable transition (the spec requires claim
    ///         in Claimable and lists no separate transition function).
    ///
    ///         Accounting (option A, decision.md): the payout increases the
    ///         caller's balance AND confidentialTotal, so
    ///         total == sum(credited) always. The prize can never retroactively
    ///         affect the completed draw - claim is only reachable after Drawn.
    ///
    ///         Replay: per-user, enforced by the _claimed flag. A non-winner
    ///         claiming zero still consumes their own claim attempt.
    function claim() external {
        require(
            roundState == RoundState.Drawn || roundState == RoundState.Claimable,
            "not claimable"
        );
        require(isParticipant[msg.sender], "not participant");
        if (roundState == RoundState.Drawn) {
            roundState = RoundState.Claimable;
        }
        require(!_claimed[msg.sender], "already claimed");
        _claimed[msg.sender] = true;

        // Scalar comparison against the plaintext participant index (0-based
        // here; the stored participantIndex is 1-based). Encrypted all the
        // way - the winner index is never decrypted or revealed.
        ebool isWinner = FHE.eq(
            _winnerIndex,
            FHE.asEuint16(uint16(participantIndex[msg.sender] - 1))
        );
        euint64 payout = FHE.select(isWinner, _prizeReserve, FHE.asEuint64(0));

        (, euint64 newBalance) = FHESafeMath.tryAdd(_credited[msg.sender], payout);
        _credited[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        (, euint64 newReserve) = FHESafeMath.trySub(_prizeReserve, payout);
        _prizeReserve = newReserve;
        FHE.allowThis(newReserve);

        (, euint64 newTotal) = FHESafeMath.tryAdd(_confidentialTotal, payout);
        _confidentialTotal = newTotal;
        FHE.allowThis(newTotal);

        emit Claimed(msg.sender);
    }

    /// @notice Whether `user` has already claimed this round (public by
    ///         design: claim activity is public, amounts are not).
    function hasClaimed(address user) external view returns (bool) {
        return _claimed[user];
    }

    function _registerParticipant(address user) private {
        uint16 index = uint16(participants.length);
        isParticipant[user] = true;
        participantIndex[user] = uint16(index + 1);
        participants.push(user);
        participantCount += 1;
        emit ParticipantRegistered(user, index);
    }
}