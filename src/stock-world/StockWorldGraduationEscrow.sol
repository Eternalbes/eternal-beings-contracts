// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

interface IWorldRewardReserve {
    function releaseLiquidityReserve() external returns (uint256 amount);
    function releaseLiquidityReserve(uint256 maxAmount) external returns (uint256 amount);
}

/**
 * @title StockWorldGraduationEscrow
 * @notice Per-World, non-custodial staging account for graduation reserves.
 * @dev There is no owner withdrawal. Only the immutable factory can account and
 *      arm reserves, and only the immutable coordinator can consume them.
 */
contract StockWorldGraduationEscrow {
    using SafeERC20 for IERC20Minimal;

    IERC20Minimal public immutable quoteAsset;
    IERC20Minimal public immutable worldToken;
    IWorldRewardReserve public immutable rewardVault;
    address public immutable factory;
    address public immutable coordinator;

    uint256 public trackedQuote;
    uint256 public trackedTokens;
    bool public curveSweepRecorded;
    bool public releaseArmed;
    bool public released;

    error ZeroAddress();
    error NotContract();
    error NotFactory();
    error NotCoordinator();
    error AlreadyRecorded();
    error AlreadyArmed();
    error AlreadyReleased();
    error NotReleased();
    error NotArmed();
    error InvalidBalance();
    error UnsupportedTokenBehavior();

    event CurveSweepRecorded(uint256 quoteAmount, uint256 tokenAmount);
    event RewardReserveCollected(uint256 amount);
    event ReleaseArmed(uint256 quoteAmount, uint256 tokenAmount);
    event ReservesReleased(address indexed coordinator, uint256 quoteAmount, uint256 tokenAmount);
    event PostGraduationReserveForwarded(address indexed coordinator, uint256 amount);

    constructor(
        IERC20Minimal quoteAsset_,
        IERC20Minimal worldToken_,
        IWorldRewardReserve rewardVault_,
        address factory_,
        address coordinator_
    ) {
        if (
            address(quoteAsset_) == address(0) || address(worldToken_) == address(0)
                || address(rewardVault_) == address(0) || factory_ == address(0) || coordinator_ == address(0)
        ) revert ZeroAddress();
        if (
            address(quoteAsset_).code.length == 0 || address(worldToken_).code.length == 0
                || address(rewardVault_).code.length == 0 || coordinator_.code.length == 0
        ) revert NotContract();

        quoteAsset = quoteAsset_;
        worldToken = worldToken_;
        rewardVault = rewardVault_;
        factory = factory_;
        coordinator = coordinator_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function recordCurveSweep(uint256 quoteAmount, uint256 tokenAmount) external onlyFactory {
        if (curveSweepRecorded) revert AlreadyRecorded();
        if (quoteAsset.balanceOf(address(this)) < quoteAmount || worldToken.balanceOf(address(this)) < tokenAmount) {
            revert InvalidBalance();
        }

        curveSweepRecorded = true;
        trackedQuote = quoteAmount;
        trackedTokens = tokenAmount;
        emit CurveSweepRecorded(quoteAmount, tokenAmount);
    }

    function collectRewardReserve(uint256 maxAmount) external onlyFactory returns (uint256 amount) {
        if (released) revert AlreadyReleased();

        uint256 balanceBefore = quoteAsset.balanceOf(address(this));
        amount = rewardVault.releaseLiquidityReserve(maxAmount);
        uint256 balanceAfter = quoteAsset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }

        trackedQuote += amount;
        emit RewardReserveCollected(amount);
    }

    function armRelease() external onlyFactory {
        if (!curveSweepRecorded) revert InvalidBalance();
        if (releaseArmed) revert AlreadyArmed();
        if (released) revert AlreadyReleased();

        releaseArmed = true;
        emit ReleaseArmed(trackedQuote, trackedTokens);
    }

    function releaseReserves() external returns (uint256 quoteAmount, uint256 tokenAmount) {
        if (msg.sender != coordinator) revert NotCoordinator();
        if (!releaseArmed) revert NotArmed();
        if (released) revert AlreadyReleased();

        quoteAmount = trackedQuote;
        tokenAmount = trackedTokens;
        if (quoteAsset.balanceOf(address(this)) < quoteAmount || worldToken.balanceOf(address(this)) < tokenAmount) {
            revert InvalidBalance();
        }

        released = true;
        trackedQuote = 0;
        trackedTokens = 0;
        if (quoteAmount != 0) quoteAsset.safeTransfer(coordinator, quoteAmount);
        if (tokenAmount != 0) worldToken.safeTransfer(coordinator, tokenAmount);

        emit ReservesReleased(coordinator, quoteAmount, tokenAmount);
    }

    /**
     * @notice Sends later rounding reserves from permanent-market fees to the
     *         same immutable coordinator. Anyone may keep this maintenance path live.
     */
    function forwardPostGraduationReserve() external returns (uint256 amount) {
        if (!released) revert NotReleased();

        uint256 balanceBefore = quoteAsset.balanceOf(address(this));
        amount = rewardVault.releaseLiquidityReserve();
        uint256 balanceAfter = quoteAsset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }

        quoteAsset.safeTransfer(coordinator, amount);
        emit PostGraduationReserveForwarded(coordinator, amount);
    }
}
