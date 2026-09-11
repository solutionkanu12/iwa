// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title IwaCircleCelo
/// @notice One immutable rotating-savings circle. The contract holds cNGN;
///         no owner, pause, upgrade, or privileged withdrawal exists.
/// @dev Native Celo settlement of IWA circle rules. Not a port of Cairo internals.
contract IwaCircleCelo is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant CNGN_MAINNET = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;
    uint256 public constant CELO_MAINNET_CHAIN_ID = 42220;
    uint8 public constant MAX_MEMBERS = 32;

    enum CircleStatus {
        Active,
        Completed
    }

    enum ContributionStatus {
        Pending,
        OnTime,
        LateWithinGrace,
        MissedDefault
    }

    enum PayoutStatus {
        Scheduled,
        Paid,
        DeferredLocked
    }

    error InvalidConfig();
    error UnsupportedToken();
    error NotMember();
    error Inactive();
    error AlreadySatisfied();
    error WrongRound();
    error WindowClosed();
    error GraceNotExpired();
    error HistoryImmutable();
    error ShortTransfer();
    error RoundNotFunded();
    error PayoutLocked();
    error AlreadyCollected();
    error ObligationsOpen();
    error NoDeficit();
    error NotRecoverable();
    error AlreadyRecovered();

    IERC20 public immutable token;
    uint256 public immutable contributionAmount;
    uint64 public immutable cadenceSeconds;
    uint64 public immutable gracePeriodSeconds;
    uint8 public immutable memberCount;

    CircleStatus public status;
    uint32 public currentRound;
    uint64 public roundStartedAt;

    address[] private _members;
    mapping(address => uint8) private _slot; // 1-based; 0 = not a member
    mapping(uint32 => mapping(address => ContributionStatus)) private _contribution;
    mapping(uint32 => PayoutStatus) private _payout;
    mapping(uint32 => mapping(address => bool)) private _recovered;

    event Contributed(address indexed member, uint32 indexed round, ContributionStatus outcome);
    event Defaulted(address indexed member, uint32 indexed round);
    event Collected(address indexed member, uint32 indexed round, uint256 pot);
    event PayoutLockedAndAdvanced(uint32 indexed round, uint32 nextRound);
    event Recovered(address indexed member, uint32 indexed round, uint256 amount);

    constructor(
        address token_,
        uint256 contributionAmount_,
        uint64 cadenceSeconds_,
        uint64 gracePeriodSeconds_,
        address[] memory members_
    ) {
        if (block.chainid == CELO_MAINNET_CHAIN_ID && token_ != CNGN_MAINNET) {
            revert UnsupportedToken();
        }
        if (token_ == address(0) || contributionAmount_ == 0 || cadenceSeconds_ == 0) {
            revert InvalidConfig();
        }
        uint256 n = members_.length;
        if (n < 2 || n > MAX_MEMBERS) revert InvalidConfig();

        for (uint256 i = 0; i < n; i++) {
            address member = members_[i];
            if (member == address(0) || _slot[member] != 0) revert InvalidConfig();
            _slot[member] = uint8(i + 1);
            _members.push(member);
        }

        token = IERC20(token_);
        contributionAmount = contributionAmount_;
        cadenceSeconds = cadenceSeconds_;
        gracePeriodSeconds = gracePeriodSeconds_;
        memberCount = uint8(n);
        currentRound = 1;
        roundStartedAt = uint64(block.timestamp);
        status = CircleStatus.Active;
        _payout[1] = PayoutStatus.Scheduled;
    }

    function dueAt() public view returns (uint64) {
        return roundStartedAt + cadenceSeconds;
    }

    function graceEndsAt() public view returns (uint64) {
        return dueAt() + gracePeriodSeconds;
    }

    function memberAt(uint256 index) external view returns (address) {
        return _members[index];
    }

    function isMember(address account) public view returns (bool) {
        return _slot[account] != 0;
    }

    function scheduledMember(uint32 round) public view returns (address) {
        if (round == 0 || round > memberCount) revert WrongRound();
        return _members[round - 1];
    }

    function contributionStatus(uint32 round, address member) external view returns (ContributionStatus) {
        return _contribution[round][member];
    }

    function payoutStatus(uint32 round) external view returns (PayoutStatus) {
        return _payout[round];
    }

    /// @notice Pay the fixed contribution for the current round. Amount and
    ///         recipient are not arguments; the token is the bound cNGN.
    function contribute() external nonReentrant {
        if (status != CircleStatus.Active) revert Inactive();
        if (_slot[msg.sender] == 0) revert NotMember();
        uint32 round = currentRound;
        if (_contribution[round][msg.sender] != ContributionStatus.Pending) {
            revert AlreadySatisfied();
        }
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs > graceEndsAt()) revert WindowClosed();

        ContributionStatus outcome = nowTs <= dueAt()
            ? ContributionStatus.OnTime
            : ContributionStatus.LateWithinGrace;

        _contribution[round][msg.sender] = outcome;

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), contributionAmount);
        if (token.balanceOf(address(this)) - before != contributionAmount) {
            revert ShortTransfer();
        }

        emit Contributed(msg.sender, round, outcome);
    }

    /// @notice Permissionless post-grace default. Does not move tokens.
    function finalizeDefault(address member) external {
        if (status != CircleStatus.Active) revert Inactive();
        if (_slot[member] == 0) revert NotMember();
        uint32 round = currentRound;
        if (_contribution[round][member] != ContributionStatus.Pending) {
            revert HistoryImmutable();
        }
        if (uint64(block.timestamp) <= graceEndsAt()) revert GraceNotExpired();

        _contribution[round][member] = ContributionStatus.MissedDefault;
        emit Defaulted(member, round);
    }

    /// @notice Permissionless pull of the fully funded pot to the round's
    ///         scheduled member. No `to` argument and no caller check: the
    ///         destination is always `scheduledMember(round)`, never
    ///         `msg.sender`, so anyone may trigger the payout but no one can
    ///         redirect it. This keeps a member who is unreachable or simply
    ///         refuses to call collect() from freezing the circle forever.
    function collect() external nonReentrant {
        if (status != CircleStatus.Active) revert Inactive();
        uint32 round = currentRound;
        address recipient = scheduledMember(round);
        if (_payout[round] != PayoutStatus.Scheduled) revert AlreadyCollected();
        if (_anyDefault(round)) revert PayoutLocked();
        if (!_allPaid(round)) revert RoundNotFunded();

        _payout[round] = PayoutStatus.Paid;
        _advance();

        uint256 pot = contributionAmount * uint256(memberCount);
        token.safeTransfer(recipient, pot);
        emit Collected(recipient, round, pot);
    }

    /// @notice If any member defaulted and every obligation is settled, lock
    ///         the scheduled payout and continue. Funds are not redirected.
    function lockPayoutAndAdvance() external {
        if (status != CircleStatus.Active) revert Inactive();
        uint32 round = currentRound;
        if (_payout[round] != PayoutStatus.Scheduled) revert AlreadyCollected();
        if (!_allSettled(round)) revert ObligationsOpen();
        if (!_anyDefault(round)) revert NoDeficit();

        _payout[round] = PayoutStatus.DeferredLocked;
        _advance();
        emit PayoutLockedAndAdvanced(round, currentRound);
    }

    /// @notice A member who paid a locked round recovers their own contribution.
    function recover(uint32 round) external nonReentrant {
        if (_slot[msg.sender] == 0) revert NotMember();
        if (_payout[round] != PayoutStatus.DeferredLocked) revert NotRecoverable();
        ContributionStatus paid = _contribution[round][msg.sender];
        if (paid != ContributionStatus.OnTime && paid != ContributionStatus.LateWithinGrace) {
            revert NotRecoverable();
        }
        if (_recovered[round][msg.sender]) revert AlreadyRecovered();

        _recovered[round][msg.sender] = true;
        token.safeTransfer(msg.sender, contributionAmount);
        emit Recovered(msg.sender, round, contributionAmount);
    }

    function _allPaid(uint32 round) private view returns (bool) {
        for (uint256 i = 0; i < _members.length; i++) {
            ContributionStatus st = _contribution[round][_members[i]];
            if (st != ContributionStatus.OnTime && st != ContributionStatus.LateWithinGrace) {
                return false;
            }
        }
        return true;
    }

    function _anyDefault(uint32 round) private view returns (bool) {
        for (uint256 i = 0; i < _members.length; i++) {
            if (_contribution[round][_members[i]] == ContributionStatus.MissedDefault) {
                return true;
            }
        }
        return false;
    }

    function _allSettled(uint32 round) private view returns (bool) {
        for (uint256 i = 0; i < _members.length; i++) {
            if (_contribution[round][_members[i]] == ContributionStatus.Pending) {
                return false;
            }
        }
        return true;
    }

    function _advance() private {
        if (currentRound >= memberCount) {
            status = CircleStatus.Completed;
            return;
        }
        currentRound += 1;
        roundStartedAt = uint64(block.timestamp);
        _payout[currentRound] = PayoutStatus.Scheduled;
    }
}
