// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./libraries/FullMath.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

interface ITokenRewardVault {
    function totalActiveStake() external view returns (uint256);
    function depositReward(uint256 amount) external;
}

/**
 * @title WorldRewardVault
 * @notice Splits quote-asset fees between Token stake, NFT weight, and creator balances.
 * @dev The factory may bind the NFT controller and graduation reserve recipient once.
 *      It has no power to alter allocations or withdraw participant rewards.
 */
contract WorldRewardVault {
    using SafeERC20 for IERC20Minimal;

    uint256 public constant REWARD_SCALE = 1e27;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_CREATOR_BPS = 3_000;

    struct NftPosition {
        uint256 weight;
        uint256 rewardDebt;
    }

    IERC20Minimal public immutable quoteAsset;
    ITokenRewardVault public immutable tokenRewardVault;
    address public immutable factory;
    address public immutable creator;
    uint16 public immutable tokenHolderBps;
    uint16 public immutable nftHolderBps;
    uint16 public immutable creatorBps;

    address public nftController;
    address public liquidityReserveRecipient;

    uint256 public totalNftWeight;
    uint256 public rewardPerNftWeight;
    uint256 public creatorClaimable;
    uint256 public unallocatedTokenReserve;
    uint256 public unallocatedNftReserve;
    uint256 public liquidityReserve;
    uint256 public totalFeesDeposited;
    uint256 public totalNftRewardsClaimed;
    uint256 public totalCreatorRewardsClaimed;
    uint256 public totalLiquidityReserveReleased;

    mapping(uint256 tokenId => NftPosition position) private nftPositions;
    mapping(address account => uint256 amount) public nftClaimable;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error ZeroAmount();
    error NotContract();
    error InvalidAllocation();
    error CreatorAllocationTooHigh();
    error NotFactory();
    error NotCreator();
    error AlreadyBound();
    error NotNftController();
    error NotLiquidityReserveRecipient();
    error NothingToClaim();
    error NothingToRelease();
    error UnsupportedTokenBehavior();
    error ReentrantCall();

    event WorldModulesBound(address indexed nftController, address indexed liquidityReserveRecipient);
    event FeeDeposited(
        address indexed source,
        uint256 amount,
        uint256 tokenAmount,
        uint256 nftAmount,
        uint256 creatorAmount,
        uint256 liquidityAmount
    );
    event NftWeightCheckpointed(
        uint256 indexed tokenId, address indexed beneficiary, uint256 previousWeight, uint256 newWeight
    );
    event NftRewardClaimed(address indexed account, address indexed to, uint256 amount);
    event CreatorRewardClaimed(address indexed creator, address indexed to, uint256 amount);
    event ZeroWeightReservesCommitted(uint256 tokenAmount, uint256 nftAmount, uint256 totalLiquidityReserve);
    event LiquidityReserveReleased(address indexed recipient, uint256 amount);

    constructor(
        IERC20Minimal quoteAsset_,
        ITokenRewardVault tokenRewardVault_,
        address factory_,
        address creator_,
        uint16 tokenHolderBps_,
        uint16 nftHolderBps_,
        uint16 creatorBps_
    ) {
        if (
            address(quoteAsset_) == address(0) || address(tokenRewardVault_) == address(0)
                || factory_ == address(0) || creator_ == address(0)
        ) revert ZeroAddress();
        if (address(quoteAsset_).code.length == 0 || address(tokenRewardVault_).code.length == 0) {
            revert NotContract();
        }
        if (creatorBps_ > MAX_CREATOR_BPS) revert CreatorAllocationTooHigh();
        if (
            tokenHolderBps_ == 0 || nftHolderBps_ == 0
                || uint256(tokenHolderBps_) + uint256(nftHolderBps_) + uint256(creatorBps_) != BPS_DENOMINATOR
        ) revert InvalidAllocation();

        quoteAsset = quoteAsset_;
        tokenRewardVault = tokenRewardVault_;
        factory = factory_;
        creator = creator_;
        tokenHolderBps = tokenHolderBps_;
        nftHolderBps = nftHolderBps_;
        creatorBps = creatorBps_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function bindWorldModules(address nftController_, address liquidityReserveRecipient_) external {
        if (msg.sender != factory) revert NotFactory();
        if (nftController != address(0)) revert AlreadyBound();
        if (nftController_ == address(0) || liquidityReserveRecipient_ == address(0)) revert ZeroAddress();
        if (nftController_.code.length == 0 || liquidityReserveRecipient_.code.length == 0) revert NotContract();

        nftController = nftController_;
        liquidityReserveRecipient = liquidityReserveRecipient_;
        emit WorldModulesBound(nftController_, liquidityReserveRecipient_);
    }

    function depositFee(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _pullExact(msg.sender, amount);

        uint256 tokenAmount = FullMath.mulDiv(amount, tokenHolderBps, BPS_DENOMINATOR);
        uint256 nftAmount = FullMath.mulDiv(amount, nftHolderBps, BPS_DENOMINATOR);
        uint256 creatorAmount = FullMath.mulDiv(amount, creatorBps, BPS_DENOMINATOR);
        uint256 liquidityAmount = amount - tokenAmount - nftAmount - creatorAmount;

        totalFeesDeposited += amount;
        creatorClaimable += creatorAmount;
        liquidityReserve += liquidityAmount;

        if (tokenAmount != 0) {
            if (tokenRewardVault.totalActiveStake() == 0) {
                unallocatedTokenReserve += tokenAmount;
            } else {
                quoteAsset.forceApprove(address(tokenRewardVault), tokenAmount);
                tokenRewardVault.depositReward(tokenAmount);
            }
        }

        if (nftAmount != 0) {
            if (totalNftWeight == 0) {
                unallocatedNftReserve += nftAmount;
            } else {
                rewardPerNftWeight += FullMath.mulDiv(nftAmount, REWARD_SCALE, totalNftWeight);
            }
        }

        emit FeeDeposited(msg.sender, amount, tokenAmount, nftAmount, creatorAmount, liquidityAmount);
    }

    function checkpointNftWeight(uint256 tokenId, address beneficiary, uint256 newWeight) external nonReentrant {
        if (msg.sender != nftController) revert NotNftController();
        if (beneficiary == address(0)) revert ZeroAddress();

        NftPosition storage position = nftPositions[tokenId];
        uint256 previousWeight = position.weight;
        uint256 accumulated = FullMath.mulDiv(previousWeight, rewardPerNftWeight, REWARD_SCALE);
        if (accumulated > position.rewardDebt) {
            nftClaimable[beneficiary] += accumulated - position.rewardDebt;
        }

        if (previousWeight == 0 && totalNftWeight == 0 && newWeight != 0 && unallocatedNftReserve != 0) {
            uint256 reserve = unallocatedNftReserve;
            unallocatedNftReserve = 0;
            liquidityReserve += reserve;
            emit ZeroWeightReservesCommitted(0, reserve, liquidityReserve);
        }

        totalNftWeight = totalNftWeight - previousWeight + newWeight;
        position.weight = newWeight;
        position.rewardDebt = FullMath.mulDiv(newWeight, rewardPerNftWeight, REWARD_SCALE);

        emit NftWeightCheckpointed(tokenId, beneficiary, previousWeight, newWeight);
    }

    function commitZeroWeightReserves() external returns (uint256 committed) {
        uint256 tokenAmount = unallocatedTokenReserve;
        uint256 nftAmount = unallocatedNftReserve;
        committed = tokenAmount + nftAmount;
        if (committed == 0) return 0;

        unallocatedTokenReserve = 0;
        unallocatedNftReserve = 0;
        liquidityReserve += committed;
        emit ZeroWeightReservesCommitted(tokenAmount, nftAmount, liquidityReserve);
    }

    function claimNftReward(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = nftClaimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        nftClaimable[msg.sender] = 0;
        totalNftRewardsClaimed += amount;
        quoteAsset.safeTransfer(to, amount);
        emit NftRewardClaimed(msg.sender, to, amount);
    }

    function claimCreatorReward(address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = creatorClaimable;
        if (amount == 0) revert NothingToClaim();

        creatorClaimable = 0;
        totalCreatorRewardsClaimed += amount;
        quoteAsset.safeTransfer(to, amount);
        emit CreatorRewardClaimed(msg.sender, to, amount);
    }

    function releaseLiquidityReserve() external nonReentrant returns (uint256 amount) {
        if (msg.sender != liquidityReserveRecipient) revert NotLiquidityReserveRecipient();
        amount = liquidityReserve;
        if (amount == 0) revert NothingToRelease();

        liquidityReserve = 0;
        totalLiquidityReserveReleased += amount;
        quoteAsset.safeTransfer(msg.sender, amount);
        emit LiquidityReserveReleased(msg.sender, amount);
    }

    function nftPosition(uint256 tokenId) external view returns (NftPosition memory) {
        return nftPositions[tokenId];
    }

    function pendingNftReward(uint256 tokenId) external view returns (uint256) {
        NftPosition memory position = nftPositions[tokenId];
        uint256 accumulated = FullMath.mulDiv(position.weight, rewardPerNftWeight, REWARD_SCALE);
        return accumulated - position.rewardDebt;
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 balanceBefore = quoteAsset.balanceOf(address(this));
        quoteAsset.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = quoteAsset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert UnsupportedTokenBehavior();
    }
}
