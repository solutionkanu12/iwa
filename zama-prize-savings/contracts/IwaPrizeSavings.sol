// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, euint16, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @notice IwaPrizeSavings - the ONE Iwa Prize Savings pool. Confidential
///         deposit/withdraw of lifetime principal, plus a sequence of
///         explicit-opt-in prize rounds that run indefinitely
///         (Round 1 -> Round 2 -> Round 3 -> ...).
///
///         Lifecycle per round: Open (join/lock/fund) -> Locked (draw
///         pending) -> Drawn (claims open) -> Claimable (first claim
///         landed). The NEXT round opens automatically, in the same
///         transaction as draw(), so the pool is never permanently
///         terminal. A round's own participants/claim/winner/reserve
///         storage stays addressable forever by its roundId, so a winner
///         who has not yet claimed keeps their claim after later rounds
///         open (spec: "claims across rounds").
///
///         Principal (`_credited`, `_confidentialTotal`) is GLOBAL and
///         lifetime: it is never reset, moved, or seized by a round
///         transition. Joining a round is a separate, explicit action
///         (`joinRound`) from saving (`deposit`) - a returning saver with
///         existing credited savings is never auto-entered into a new
///         round.
///
///         Accounting rule (C1, mandatory): ONLY the actual returned ERC-7984
///         transfer amount is credited or debited - never the requested
///         amount.
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
    ///      new HCU measurement. Scoped PER ROUND (spec: "16 users maximum
    ///      PER ROUND, not 16 unique users for the lifetime of the
    ///      contract") - a round's participant set starts empty and is
    ///      independent of every other round's.
    uint256 public immutable MAX_PARTICIPANTS;

    /// @dev Plaintext power-of-two bound (2^10 = 1024, the S2-measured bound)
    ///      for deposit headroom and bounded FHE draw randomness (spec 7.1).
    ///      This bounds the GLOBAL lifetime `_confidentialTotal`. Because any
    ///      single round's joined-participant weight is always a subset of
    ///      that global total, the draw's ticket bound remains valid for
    ///      every round without any round-scoped cap of its own.
    uint256 public immutable MAX_POOL_TOTAL;

    /// @dev Permissionless-draw delay after lock (C6). Approved 2026-09-05:
    ///      Sepolia bounty-MVP value only, MUST be reviewed before any
    ///      production deployment (decision.md).
    uint256 public constant DRAW_TIMEOUT = 900;

    /// @dev Rollover sentinel (spec 7.3): 65535 can never collide with a
    ///      valid participant index (always < MAX_PARTICIPANTS).
    uint16 private constant NO_WINNER = type(uint16).max;

    IERC7984 public immutable token;

    /// @dev The round currently accepting joins/locks/draws. Starts at 1
    ///      (spec: "Prefer starting at roundId = 1"). Strictly increases by
    ///      exactly one, exactly when the previous round's draw() runs -
    ///      never skips, never rewinds, never reset.
    uint256 public currentRoundId;

    /// @dev Lifetime principal, independent of any round. Never reset,
    ///      moved, or seized by joining a round, locking a round, drawing a
    ///      round, or a round transition of any kind.
    mapping(address => euint64) private _credited;

    /// @dev Plaintext, non-decrypting join-eligibility signal. Deliberately
    ///      NOT derived from `FHE.isInitialized(_credited[user])`: that only
    ///      tracks whether a handle was EVER written, which stays true
    ///      forever after a single deposit even across a full withdrawal -
    ///      the encrypted balance amount is never decrypted or branched on
    ///      to compute this. Instead this is a self-asserted signal from
    ///      function identity alone: deposit() sets it true (any deposit
    ///      attempt, matching the existing accepted zero-transfer tradeoff -
    ///      see joinRound's docs); withdrawAll() - the caller's own explicit
    ///      "I am taking everything" call - sets it false. Given the pinned
    ///      ERC7984 all-or-nothing transfer semantics and the pool's
    ///      solvency invariant, withdrawAll() reaching this point always
    ///      does empty the caller's credited balance. A partial withdraw()
    ///      that happens to drain the balance to exactly zero is NOT
    ///      detected (that would require decrypting an amount); the
    ///      residual is the same accepted zero-weight-participant tradeoff
    ///      as before, not a new one.
    mapping(address => bool) private _hasSavings;

    /// @dev Sum of all `_credited` balances, across every user, regardless
    ///      of which round (if any) they have joined. Bounds deposit
    ///      headroom (spec 6.4). NEVER merged with any round's prize
    ///      reserve: the prize must not inflate winning weight.
    euint64 private _confidentialTotal;

    /// @dev Per-round state. Every mapping here is scoped by roundId, so a
    ///      completed round's participants/claims/winner/reserve remain
    ///      permanently readable and claimable by their own roundId, wholly
    ///      independent of `currentRoundId`. `internal`, not `private`, so
    ///      the test-only draw harness can drive the same storage.
    struct Round {
        RoundState state;
        uint256 lockTimestamp;
        address[] participants;
        /// @dev 1-based index within THIS round; 0 means never joined.
        mapping(address => uint16) participantIndex;
        mapping(address => bool) isParticipant;
        mapping(address => bool) claimed;
        /// @dev Confidential prize reserve for THIS round only (C2, scoped
        ///      per round for multi-round safety - see claim()). Never
        ///      merged with participant draw weight.
        euint64 prizeReserve;
        /// @dev This round's random ticket and encrypted euint16 winner
        ///      index. Both stay confidential: allowThis only, no user/owner
        ///      decrypt access, no public disclosure (C4).
        euint64 drawTicket;
        euint16 winnerIndex;
    }

    mapping(uint256 => Round) internal _rounds;

    /// @dev Deliberately carry no value - only who acted.
    event Deposited(address indexed user);
    event Withdrawn(address indexed user);
    event WithdrawnAll(address indexed user);
    event JoinedRound(address indexed user, uint256 indexed roundId, uint16 index);
    event RoundOpened(uint256 indexed roundId);
    event RoundLocked(uint256 indexed roundId, uint256 lockTimestamp);
    event PrizeFunded(address indexed funder);
    event Drawn(uint256 indexed roundId);
    event Claimed(address indexed user, uint256 indexed roundId);
    event PrizeRolledOver(uint256 indexed fromRoundId, uint256 indexed toRoundId);

    constructor(IERC7984 token_) Ownable(msg.sender) {
        token = token_;
        MAX_PARTICIPANTS = 16;
        MAX_POOL_TOTAL = 1024;
        currentRoundId = 1;
        emit RoundOpened(1);
    }

    // -----------------------------------------------------------------
    // Principal: save / withdraw. Lifetime, round-independent.
    // -----------------------------------------------------------------

    /// @notice Confidential deposit of lifetime principal. Pulls cMockUSD
    ///         from the caller and credits ONLY the actual returned amount.
    ///         Deliberately does NOT join any round - saving and joining a
    ///         prize round are separate, explicit actions (see joinRound).
    ///         Allowed only while the current round is Open, preserving the
    ///         existing no-weight-change-after-lock invariant (a joined
    ///         participant's draw weight cannot be inflated between lock and
    ///         draw); a brief window while a round sits in
    ///         Locked/Drawn/Claimable resolves itself automatically once the
    ///         next round opens.
    function deposit(externalEuint64 amount, bytes calldata inputProof) external {
        require(_rounds[currentRoundId].state == RoundState.Open, "not open");

        euint64 requested = FHE.fromExternal(amount, inputProof);

        // Headroom clamp (spec 6.4): acceptedRequest = min(requested,
        // MAX_POOL_TOTAL - lifetimeTotal). Encrypted all the way - no
        // plaintext branch, no decryption of the total.
        (, euint64 headroom) = FHESafeMath.trySub(FHE.asEuint64(uint64(MAX_POOL_TOTAL)), _confidentialTotal);
        euint64 toPull = FHE.min(requested, headroom);

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

        // Plaintext, non-decrypting eligibility signal (see field doc).
        _hasSavings[msg.sender] = true;

        emit Deposited(msg.sender);
    }

    /// @notice Confidential withdrawal of a requested amount from lifetime
    ///         principal. Available regardless of round state (spec 10).
    function withdraw(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 credited = _credited[msg.sender];

        if (!FHE.isInitialized(credited)) {
            emit Withdrawn(msg.sender);
            return;
        }

        euint64 requested = FHE.fromExternal(amount, inputProof);
        euint64 toSend = FHE.min(requested, credited);

        FHE.allowTransient(toSend, address(token));

        euint64 actual = token.confidentialTransfer(msg.sender, toSend);

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
    ///         balance with NO encrypted input and NO input proof.
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

        // The caller's own explicit "take everything" call: current savings
        // are gone, so join-eligibility is revoked (see field doc). A later
        // deposit() restores it.
        _hasSavings[msg.sender] = false;

        emit WithdrawnAll(msg.sender);
    }

    // -----------------------------------------------------------------
    // Rounds: explicit join, lock, draw, claim.
    // -----------------------------------------------------------------

    /// @notice Explicit, per-round opt-in. A returning saver with existing
    ///         credited principal is NEVER auto-entered into a new round -
    ///         every round requires its own joinRound() call. Eligibility is
    ///         CURRENT savings, not historical deposit activity: a wallet
    ///         that deposited and later called withdrawAll() is not
    ///         eligible until it deposits again (see `_hasSavings` doc). A
    ///         zero-weight joiner (e.g. a shortfall/zero-transfer deposit)
    ///         is harmless (can never be selected, S2-verified) exactly as
    ///         under the original single-round design; this is not a new
    ///         eligibility model, only its explicit-opt-in restatement per
    ///         round.
    function joinRound() external {
        Round storage r = _rounds[currentRoundId];
        require(r.state == RoundState.Open, "not open");
        require(_hasSavings[msg.sender], "no savings yet");
        require(!r.isParticipant[msg.sender], "already joined");
        require(r.participants.length < MAX_PARTICIPANTS, "round full");

        r.isParticipant[msg.sender] = true;
        r.participants.push(msg.sender);
        uint16 index = uint16(r.participants.length - 1);
        r.participantIndex[msg.sender] = index + 1;

        emit JoinedRound(msg.sender, currentRoundId, index);
    }

    /// @notice Owner-only. Freezes joining and funding for the current round.
    function lockRound() external onlyOwner {
        Round storage r = _rounds[currentRoundId];
        require(r.state == RoundState.Open, "not open");
        r.state = RoundState.Locked;
        r.lockTimestamp = block.timestamp;
        emit RoundLocked(currentRoundId, r.lockTimestamp);
    }

    /// @notice Owner-only. Funds the CURRENT round's confidential prize
    ///         reserve by pulling cMockUSD and crediting ONLY the actual
    ///         returned amount (C1/C2). Allowed only while the current round
    ///         is Open. The reserve is scoped to this round; it is never
    ///         merged with another round's reserve except via the automatic,
    ///         entitlement-based settlement in _settleReserve (see draw()).
    ///
    ///         The prize is IRREVOCABLE: no function in this contract
    ///         reduces, redirects, recovers, or sweeps it. The only
    ///         legitimate movement is claim() (to a round winner) or the
    ///         automatic rollover of a genuinely no-winner leftover into the
    ///         next round the instant the round is drawn.
    function fundPrize(externalEuint64 amount, bytes calldata inputProof) external onlyOwner {
        Round storage r = _rounds[currentRoundId];
        require(r.state == RoundState.Open, "not open");

        euint64 requested = FHE.fromExternal(amount, inputProof);

        FHE.allowTransient(requested, address(token));

        euint64 actual = token.confidentialTransferFrom(msg.sender, address(this), requested);

        (, euint64 newReserve) = FHESafeMath.tryAdd(r.prizeReserve, actual);
        r.prizeReserve = newReserve;
        FHE.allowThis(newReserve);

        emit PrizeFunded(msg.sender);
    }

    /// @notice Draws the CURRENT round (spec 7), then immediately opens the
    ///         next round in the same transaction. Owner may draw
    ///         immediately after lockRound(); anyone may draw at or after
    ///         lockTimestamp + DRAW_TIMEOUT (C6). Exactly once per round.
    ///
    ///         Opening round N+1 here, right after round N's draw, is what
    ///         makes round progression automatic with no separate admin
    ///         action - and it is SAFE for round N's outstanding claims
    ///         because claim() is addressed by an explicit roundId against
    ///         round N's own permanent storage, never against
    ///         currentRoundId. A winner who has not yet claimed loses
    ///         nothing when round N+1 opens.
    function draw() external {
        uint256 roundId = currentRoundId;
        Round storage r = _rounds[roundId];
        require(r.state == RoundState.Locked, "not locked");
        require(
            msg.sender == owner() || block.timestamp >= r.lockTimestamp + DRAW_TIMEOUT,
            "not authorized"
        );
        euint64 ticket = FHE.randEuint64(uint64(MAX_POOL_TOTAL));
        _runDraw(roundId, ticket);
    }

    /// @dev The S2-proven cumulative weighted walk (spec 7.2), over ONLY the
    ///      given round's own participants and their LIVE credited
    ///      balances - never a snapshot, never another round's set. Shared
    ///      by the production draw() and the test-only harness.
    function _runDraw(uint256 roundId, euint64 ticket) internal {
        Round storage r = _rounds[roundId];

        euint64 running = FHE.asEuint64(0);
        euint16 selected = FHE.asEuint16(NO_WINNER);

        uint256 n = r.participants.length;
        for (uint16 i = 0; i < n; i++) {
            euint64 lower = running;
            running = FHE.add(running, _credited[r.participants[i]]);

            ebool inRange = FHE.and(FHE.le(lower, ticket), FHE.lt(ticket, running));
            selected = FHE.select(inRange, FHE.asEuint16(i), selected);
        }

        r.winnerIndex = selected;
        FHE.allowThis(r.winnerIndex);

        r.drawTicket = ticket;
        FHE.allowThis(r.drawTicket);

        r.state = RoundState.Drawn;
        emit Drawn(roundId);

        _advanceRound(roundId);
    }

    /// @dev Opens round `finishedRoundId + 1`, makes it current, and settles
    ///      the finished round's reserve - entitlement-based, not
    ///      participation-based (the liveness fix: no participant, winner or
    ///      not, needs to do anything for this to happen). Runs exactly
    ///      once, automatically, in the same transaction as the draw.
    function _advanceRound(uint256 finishedRoundId) internal {
        uint256 nextId = finishedRoundId + 1;
        currentRoundId = nextId;
        emit RoundOpened(nextId);
        _settleReserve(finishedRoundId, nextId);
    }

    /// @dev Entitlement-based reserve settlement, entirely in encrypted
    ///      space - never decrypted, never branched on in plaintext, and
    ///      requiring no participant (winner or loser) to have done
    ///      anything. Whether the finished round had a winner is itself an
    ///      encrypted condition (`FHE.eq` against the NO_WINNER sentinel);
    ///      `FHE.select` computes the correct amount to roll forward without
    ///      ever revealing which case occurred, and the SAME operations run
    ///      either way, so no timing/gas side channel exists either:
    ///        - a winner exists  -> toRoll = encrypted 0 (a real add/sub of
    ///          zero still executes, but changes nothing): the round's own
    ///          reserve is left completely untouched, permanently claimable
    ///          by that winner via claim(roundId), no matter how many later
    ///          rounds open.
    ///        - no winner exists -> toRoll = the round's full reserve,
    ///          moved forward immediately and automatically.
    ///      Called exactly once, from _advanceRound only, so there is no
    ///      separate, externally callable, replayable rollover path.
    function _settleReserve(uint256 fromRoundId, uint256 toRoundId) internal {
        Round storage from = _rounds[fromRoundId];
        Round storage to = _rounds[toRoundId];

        ebool isNoWinner = FHE.eq(from.winnerIndex, FHE.asEuint16(NO_WINNER));
        euint64 toRoll = FHE.select(isNoWinner, from.prizeReserve, FHE.asEuint64(0));

        (, euint64 remaining) = FHESafeMath.trySub(from.prizeReserve, toRoll);
        from.prizeReserve = remaining;
        FHE.allowThis(remaining);

        (, euint64 newToReserve) = FHESafeMath.tryAdd(to.prizeReserve, toRoll);
        to.prizeReserve = newToReserve;
        FHE.allowThis(newToReserve);

        // Emitted unconditionally, every round, with no data: emitting it
        // only "when something actually moved" would itself leak whether
        // the round had a winner through event presence alone.
        emit PrizeRolledOver(fromRoundId, toRoundId);
    }

    /// @notice Encrypted prize credit for a SPECIFIC historical round (spec
    ///         9, B3, and the multi-round claims requirement). A round's own
    ///         participant/claim/winner/reserve storage remains addressable
    ///         forever by its roundId, completely independent of
    ///         currentRoundId - so Round 1's winner can still claim Round 1
    ///         after Round 2 (or Round 30) has opened. Pull action: any
    ///         participant of THAT round claims, a winner is credited the
    ///         encrypted prize, a non-winner is credited encrypted zero -
    ///         never a revert on an encrypted condition, winner identity
    ///         stays private.
    ///
    ///         State: runs in that round's Drawn or Claimable state; the
    ///         FIRST claim in a round performs the one-time
    ///         Drawn -> Claimable transition for THAT round only.
    ///
    ///         Accounting (option A, decision.md): the payout increases the
    ///         caller's LIFETIME balance AND the lifetime confidentialTotal,
    ///         so total == sum(credited) always. The prize can never
    ///         retroactively affect the completed draw.
    ///
    ///         Replay: per-round, per-user, via `claimed`. A non-winner
    ///         claiming zero still consumes their own claim for that round
    ///         and can independently claim in a later round they join.
    function claim(uint256 roundId) external {
        require(roundId >= 1 && roundId <= currentRoundId, "invalid round");
        Round storage r = _rounds[roundId];
        require(r.state == RoundState.Drawn || r.state == RoundState.Claimable, "not claimable");
        require(r.isParticipant[msg.sender], "not participant");
        if (r.state == RoundState.Drawn) {
            r.state = RoundState.Claimable;
        }
        require(!r.claimed[msg.sender], "already claimed");
        r.claimed[msg.sender] = true;

        // Scalar comparison against the plaintext participant index (0-based
        // here; the stored participantIndex is 1-based), scoped to THIS
        // round's own winnerIndex - never another round's.
        ebool isWinner = FHE.eq(
            r.winnerIndex,
            FHE.asEuint16(uint16(r.participantIndex[msg.sender] - 1))
        );
        euint64 payout = FHE.select(isWinner, r.prizeReserve, FHE.asEuint64(0));

        (, euint64 newBalance) = FHESafeMath.tryAdd(_credited[msg.sender], payout);
        _credited[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        (, euint64 newReserve) = FHESafeMath.trySub(r.prizeReserve, payout);
        r.prizeReserve = newReserve;
        FHE.allowThis(newReserve);

        (, euint64 newTotal) = FHESafeMath.tryAdd(_confidentialTotal, payout);
        _confidentialTotal = newTotal;
        FHE.allowThis(newTotal);

        emit Claimed(msg.sender, roundId);
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// @notice The user's lifetime encrypted credited balance handle.
    ///         ACL-gated: decryptable only by the user.
    function confidentialBalanceOf(address user) external view returns (euint64) {
        return _credited[user];
    }

    /// @notice Lifetime sum of all credited balances, across every round.
    function confidentialTotal() external view returns (euint64) {
        return _confidentialTotal;
    }

    /// @notice The CURRENT round's state.
    function roundState() external view returns (RoundState) {
        return _rounds[currentRoundId].state;
    }

    /// @notice A specific round's state (Open/Locked/Drawn/Claimable).
    function roundStateOf(uint256 roundId) external view returns (RoundState) {
        return _rounds[roundId].state;
    }

    /// @notice The CURRENT round's lock timestamp (0 if not yet locked).
    function lockTimestamp() external view returns (uint256) {
        return _rounds[currentRoundId].lockTimestamp;
    }

    function lockTimestampOf(uint256 roundId) external view returns (uint256) {
        return _rounds[roundId].lockTimestamp;
    }

    /// @notice The CURRENT round's participant count (public: membership is
    ///         public by design, amounts are not).
    function participantCount() external view returns (uint256) {
        return _rounds[currentRoundId].participants.length;
    }

    function roundParticipantCount(uint256 roundId) external view returns (uint256) {
        return _rounds[roundId].participants.length;
    }

    function roundParticipantAt(uint256 roundId, uint256 index) external view returns (address) {
        return _rounds[roundId].participants[index];
    }

    /// @notice Whether `user` has joined the CURRENT round.
    function isParticipant(address user) external view returns (bool) {
        return _rounds[currentRoundId].isParticipant[user];
    }

    function isParticipantInRound(uint256 roundId, address user) external view returns (bool) {
        return _rounds[roundId].isParticipant[user];
    }

    /// @notice Whether `user` has claimed in round `roundId`. There is
    ///         deliberately no bare `hasClaimed(address)`: the current round
    ///         is always freshly Open and can never itself be claimable, so
    ///         a "claimed in the current round" reading would be
    ///         permanently and misleadingly false. Always name the round.
    function hasClaimedRound(uint256 roundId, address user) external view returns (bool) {
        return _rounds[roundId].claimed[user];
    }

    /// @notice The CURRENT round's confidential prize reserve handle
    ///         (opaque to everyone; meaningful while the round is still
    ///         Open/Locked/being funded).
    function prizeReserve() external view returns (euint64) {
        return _rounds[currentRoundId].prizeReserve;
    }

    function prizeReserveOf(uint256 roundId) external view returns (euint64) {
        return _rounds[roundId].prizeReserve;
    }

    /// @notice A specific round's encrypted euint16 winner index handle
    ///         (opaque to everyone). Only meaningful once that round has
    ///         been drawn.
    function winnerIndexOf(uint256 roundId) external view returns (euint16) {
        return _rounds[roundId].winnerIndex;
    }

    /// @notice A specific round's encrypted draw ticket handle (opaque to
    ///         everyone).
    function drawTicketOf(uint256 roundId) external view returns (euint64) {
        return _rounds[roundId].drawTicket;
    }

    /// @notice True once `roundId` is no longer the current round - i.e. it
    ///         has run its draw and is permanent history. Claims against a
    ///         finalized round remain valid forever.
    function isRoundFinalized(uint256 roundId) external view returns (bool) {
        return roundId < currentRoundId;
    }

    /// @notice Whether `user` currently has eligible savings to join a
    ///         round - CURRENT state, not historical deposit activity (see
    ///         `_hasSavings` field doc). A plain boolean: it never reveals
    ///         an amount, and is never derived from decrypting one.
    function hasSavings(address user) external view returns (bool) {
        return _hasSavings[user];
    }
}
