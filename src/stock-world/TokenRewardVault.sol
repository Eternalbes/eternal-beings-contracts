// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./libraries/FullMath.sol";
import {QuoteAssetLib} from "./libraries/QuoteAssetLib.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title TokenRewardVault
 * @notice Stakes one World Token and distributes future quote-asset fees.
 * @dev A queued stake must be activated in a later block. Activation records
 *      the current reward index, so newly active stake cannot claim history.
 */
contract TokenRewardVault {
    using SafeERC20 for IERC20Minimal;

    uint256 public constant REWARD_SCALE = 1e27;

    struct Position {
        uint256 activeStake;
        uint256 pendingStake;
        uint256 activationBlock;
        uint256 rewardDebt;
        uint256 claimable;
    }

    IERC20Minimal public immutable worldToken;
    address public immutable quoteAsset;

    uint256 public totalActiveStake;
    uint256 public totalPendingStake;
    uint256 public rewardPerShare;
    uint256 public totalRewardsDeposited;
    uint256 public totalRewardsClaimed;

    mapping(address account => Position position) private positions;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error ZeroAmount();
    error NotContract();
    error IdenticalAssets();
    error PendingStakeMustBeActivated();
    error NothingPending();
    error ActivationNotReady();
    error InsufficientActiveStake();
    error InsufficientPendingStake();
    error NoActiveStake();
    error NothingToClaim();
    error UnsupportedTokenBehavior();
    error ReentrantCall();

    event StakeQueued(address indexed account, uint256 amount, uint256 activationBlock);
    event StakeActivated(address indexed account, uint256 amount, uint256 totalActiveStake);
    event PendingStakeWithdrawn(address indexed account, address indexed to, uint256 amount);
    event StakeWithdrawn(address indexed account, address indexed to, uint256 amount);
    event RewardDeposited(address indexed source, uint256 amount, uint256 rewardPerShare);
    event RewardClaimed(address indexed account, address indexed to, uint256 amount);

    constructor(IERC20Minimal worldToken_, address quoteAsset_) {
        address worldTokenAddress = address(worldToken_);
        if (worldTokenAddress == address(0)) revert ZeroAddress();
        if (worldTokenAddress == quoteAsset_) revert IdenticalAssets();
        if (worldTokenAddress.code.length == 0 || (quoteAsset_ != address(0) && quoteAsset_.code.length == 0)) {
            revert NotContract();
        }

        worldToken = worldToken_;
        quoteAsset = quoteAsset_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function queueStake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Position storage position = positions[msg.sender];
        if (position.pendingStake != 0 && block.number >= position.activationBlock) {
            revert PendingStakeMustBeActivated();
        }

        _settle(position);
        _pullExact(worldToken, msg.sender, amount);

        if (position.pendingStake == 0) position.activationBlock = block.number + 1;
        position.pendingStake += amount;
        totalPendingStake += amount;

        emit StakeQueued(msg.sender, amount, position.activationBlock);
    }

    function activateStake() external nonReentrant returns (uint256 amount) {
        Position storage position = positions[msg.sender];
        amount = position.pendingStake;
        if (amount == 0) revert NothingPending();
        if (block.number < position.activationBlock) revert ActivationNotReady();

        _settle(position);

        position.pendingStake = 0;
        position.activationBlock = 0;
        totalPendingStake -= amount;

        position.activeStake += amount;
        totalActiveStake += amount;
        position.rewardDebt = FullMath.mulDiv(position.activeStake, rewardPerShare, REWARD_SCALE);

        emit StakeActivated(msg.sender, amount, totalActiveStake);
    }

    function withdrawPendingStake(uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Position storage position = positions[msg.sender];
        if (position.pendingStake < amount) revert InsufficientPendingStake();

        position.pendingStake -= amount;
        totalPendingStake -= amount;
        if (position.pendingStake == 0) position.activationBlock = 0;

        worldToken.safeTransfer(to, amount);
        emit PendingStakeWithdrawn(msg.sender, to, amount);
    }

    function withdrawStake(uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Position storage position = positions[msg.sender];
        if (position.activeStake < amount) revert InsufficientActiveStake();

        _settle(position);
        position.activeStake -= amount;
        totalActiveStake -= amount;
        position.rewardDebt = FullMath.mulDiv(position.activeStake, rewardPerShare, REWARD_SCALE);

        worldToken.safeTransfer(to, amount);
        emit StakeWithdrawn(msg.sender, to, amount);
    }

    function depositReward(uint256 amount) external payable nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 activeStake = totalActiveStake;
        if (activeStake == 0) revert NoActiveStake();

        QuoteAssetLib.pullExact(quoteAsset, msg.sender, amount);

        rewardPerShare += FullMath.mulDiv(amount, REWARD_SCALE, activeStake);
        totalRewardsDeposited += amount;

        emit RewardDeposited(msg.sender, amount, rewardPerShare);
    }

    function claim(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();

        Position storage position = positions[msg.sender];
        _settle(position);

        amount = position.claimable;
        if (amount == 0) revert NothingToClaim();

        position.claimable = 0;
        totalRewardsClaimed += amount;

        QuoteAssetLib.send(quoteAsset, to, amount);
        emit RewardClaimed(msg.sender, to, amount);
    }

    function positionOf(address account) external view returns (Position memory) {
        return positions[account];
    }

    function pendingRewards(address account) external view returns (uint256) {
        Position memory position = positions[account];
        uint256 accumulated = FullMath.mulDiv(position.activeStake, rewardPerShare, REWARD_SCALE);
        return position.claimable + accumulated - position.rewardDebt;
    }

    function _settle(Position storage position) private {
        uint256 accumulated = FullMath.mulDiv(position.activeStake, rewardPerShare, REWARD_SCALE);
        if (accumulated > position.rewardDebt) position.claimable += accumulated - position.rewardDebt;
        position.rewardDebt = accumulated;
    }

    function _pullExact(IERC20Minimal token, address from, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert UnsupportedTokenBehavior();
    }
}
