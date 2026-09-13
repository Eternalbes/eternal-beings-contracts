// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldConstants} from "./StockWorldTypes.sol";
import {FullMath} from "./libraries/FullMath.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";
import {StockWorldCurveMath} from "./libraries/StockWorldCurveMath.sol";

interface IERC20SupplyMinimal is IERC20Minimal {
    function totalSupply() external view returns (uint256);
}

interface IWorldRewardVaultFeeSink {
    function quoteAsset() external view returns (address);
    function depositFee(uint256 amount) external;
}

/**
 * @title StockWorldBondingCurve
 * @notice Immutable pre-graduation constant-product market for one Stock World.
 * @dev Its tracked reserves, partial-fill boundary, quote-leg fee treatment,
 *      and graduation ordering follow the mature MIT-licensed Pons V2 design.
 *      This implementation is ERC-20 quote only and routes every fee into the
 *      Stock World reward system instead of protocol/creator fee escrows.
 */
contract StockWorldBondingCurve {
    using SafeERC20 for IERC20Minimal;

    enum Phase {
        Uninitialized,
        CurveLive,
        GraduationReady,
        ReservesSwept
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FEE_BPS = StockWorldConstants.BASE_TRADING_FEE_BPS;

    IERC20Minimal public immutable quoteAsset;
    IWorldRewardVaultFeeSink public immutable rewardVault;
    address public immutable factory;
    uint256 public immutable virtualQuoteReserve;
    uint256 public immutable graduationTarget;

    IERC20SupplyMinimal public worldToken;
    uint256 public trackedQuoteReserve;
    uint256 public trackedTokenReserve;
    uint256 public reservedTokens;
    uint256 public totalQuoteFees;
    Phase public phase;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidEconomics();
    error NotFactory();
    error AlreadyInitialized();
    error NotInitialized();
    error CurveClosed();
    error NotReadyToGraduate();
    error ZeroAmount();
    error FeeRoundsToZero();
    error MinimumOutputRequired();
    error DeadlineExpired();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error InsufficientRealQuoteReserve();
    error UnsupportedTokenBehavior();
    error ReentrantCall();

    event Initialized(address indexed worldToken, uint256 tokenReserve, uint256 reservedTokens);
    event CurveBuy(
        address indexed buyer,
        address indexed recipient,
        uint256 quoteSpent,
        uint256 tokensOut,
        uint256 fee,
        uint256 refund
    );
    event CurveSell(
        address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee
    );
    event GraduationBecameReady(uint256 realQuoteReserve, uint256 tokenReserve);
    event ReservesSwept(address indexed recipient, uint256 quoteAmount, uint256 tokenAmount);

    constructor(
        IERC20Minimal quoteAsset_,
        IWorldRewardVaultFeeSink rewardVault_,
        address factory_,
        uint256 virtualQuoteReserve_,
        uint256 graduationTarget_
    ) {
        if (address(quoteAsset_) == address(0) || address(rewardVault_) == address(0) || factory_ == address(0)) {
            revert ZeroAddress();
        }
        if (address(quoteAsset_).code.length == 0 || address(rewardVault_).code.length == 0) revert NotContract();
        if (virtualQuoteReserve_ == 0 || graduationTarget_ == 0) revert InvalidEconomics();
        if (virtualQuoteReserve_ > type(uint256).max - graduationTarget_) revert InvalidEconomics();
        if (rewardVault_.quoteAsset() != address(quoteAsset_)) revert InvalidEconomics();

        quoteAsset = quoteAsset_;
        rewardVault = rewardVault_;
        factory = factory_;
        virtualQuoteReserve = virtualQuoteReserve_;
        graduationTarget = graduationTarget_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function initialize(IERC20SupplyMinimal worldToken_) external onlyFactory {
        if (phase != Phase.Uninitialized) revert AlreadyInitialized();
        if (address(worldToken_) == address(0)) revert ZeroAddress();
        if (address(worldToken_).code.length == 0) revert NotContract();

        uint256 supply = worldToken_.totalSupply();
        uint256 balance = worldToken_.balanceOf(address(this));
        if (supply == 0 || balance != supply) revert InvalidEconomics();

        uint256 reserved = FullMath.mulDiv(
            supply, virtualQuoteReserve, virtualQuoteReserve + graduationTarget
        );
        if (reserved == 0 || reserved >= supply) revert InvalidEconomics();

        worldToken = worldToken_;
        trackedTokenReserve = balance;
        reservedTokens = reserved;
        phase = Phase.CurveLive;

        emit Initialized(address(worldToken_), balance, reserved);
    }

    function getReserves() public view returns (uint256 quoteReserve, uint256 tokenReserve) {
        _requireInitialized();
        return (virtualQuoteReserve + trackedQuoteReserve, trackedTokenReserve);
    }

    function sellableTokens() public view returns (uint256) {
        uint256 tracked = trackedTokenReserve;
        return tracked > reservedTokens ? tracked - reservedTokens : 0;
    }

    function readyToGraduate() external view returns (bool) {
        return phase == Phase.GraduationReady;
    }

    function previewBuy(uint256 quoteIn)
        public
        view
        returns (uint256 quoteSpent, uint256 tokensOut, uint256 fee, uint256 refund)
    {
        _requireLive();
        if (quoteIn == 0) revert ZeroAmount();

        fee = FullMath.mulDiv(quoteIn, FEE_BPS, BPS_DENOMINATOR);
        if (fee == 0) revert FeeRoundsToZero();

        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = getReserves();
        tokensOut = StockWorldCurveMath.getAmountOut(quoteIn - fee, quoteReserveBefore, tokenReserveBefore, 0);

        uint256 sellable = sellableTokens();
        if (sellable == 0) revert CurveClosed();

        quoteSpent = quoteIn;
        if (tokensOut > sellable) {
            tokensOut = sellable;
            uint256 netRequired = StockWorldCurveMath.getAmountIn(sellable, quoteReserveBefore, tokenReserveBefore, 0);
            quoteSpent = FullMath.mulDivRoundingUp(
                netRequired, BPS_DENOMINATOR, BPS_DENOMINATOR - FEE_BPS
            );
            if (quoteSpent > quoteIn) quoteSpent = quoteIn;
            fee = FullMath.mulDiv(quoteSpent, FEE_BPS, BPS_DENOMINATOR);
        }

        refund = quoteIn - quoteSpent;
    }

    function previewSell(uint256 tokensIn) public view returns (uint256 quoteOut, uint256 fee) {
        _requireLive();
        if (tokensIn == 0) revert ZeroAmount();

        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = getReserves();
        uint256 grossQuoteOut =
            StockWorldCurveMath.getAmountOut(tokensIn, tokenReserveBefore, quoteReserveBefore, 0);
        if (grossQuoteOut > trackedQuoteReserve) revert InsufficientRealQuoteReserve();

        fee = FullMath.mulDiv(grossQuoteOut, FEE_BPS, BPS_DENOMINATOR);
        if (fee == 0) revert FeeRoundsToZero();
        quoteOut = grossQuoteOut - fee;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (minTokensOut == 0) revert MinimumOutputRequired();
        if (block.timestamp > deadline) revert DeadlineExpired();

        _pullExact(quoteAsset, msg.sender, quoteIn);
        (uint256 quoteSpent, uint256 output, uint256 fee, uint256 refund) = previewBuy(quoteIn);
        tokensOut = output;

        uint256 proportionalMinimum = FullMath.mulDivRoundingUp(minTokensOut, quoteSpent, quoteIn);
        if (tokensOut < proportionalMinimum) revert SlippageExceeded(tokensOut, proportionalMinimum);

        trackedQuoteReserve += quoteSpent - fee;
        trackedTokenReserve -= tokensOut;
        totalQuoteFees += fee;
        if (sellableTokens() == 0) {
            phase = Phase.GraduationReady;
            emit GraduationBecameReady(trackedQuoteReserve, trackedTokenReserve);
        }

        IERC20Minimal(address(worldToken)).safeTransfer(recipient, tokensOut);
        if (fee != 0) _depositFee(fee);
        if (refund != 0) quoteAsset.safeTransfer(msg.sender, refund);

        emit CurveBuy(msg.sender, recipient, quoteSpent, tokensOut, fee, refund);
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (minQuoteOut == 0) revert MinimumOutputRequired();
        if (block.timestamp > deadline) revert DeadlineExpired();

        (uint256 output, uint256 fee) = previewSell(tokensIn);
        quoteOut = output;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        _pullExact(IERC20Minimal(address(worldToken)), msg.sender, tokensIn);
        uint256 grossQuoteOut = quoteOut + fee;
        trackedTokenReserve += tokensIn;
        trackedQuoteReserve -= grossQuoteOut;
        totalQuoteFees += fee;

        quoteAsset.safeTransfer(recipient, quoteOut);
        if (fee != 0) _depositFee(fee);

        emit CurveSell(msg.sender, recipient, tokensIn, quoteOut, fee);
    }

    function sweepForGraduation(address recipient)
        external
        onlyFactory
        nonReentrant
        returns (uint256 quoteAmount, uint256 tokenAmount)
    {
        if (phase != Phase.GraduationReady) revert NotReadyToGraduate();
        if (recipient == address(0)) revert ZeroAddress();

        phase = Phase.ReservesSwept;
        quoteAmount = trackedQuoteReserve;
        tokenAmount = trackedTokenReserve;
        trackedQuoteReserve = 0;
        trackedTokenReserve = 0;

        if (quoteAmount != 0) quoteAsset.safeTransfer(recipient, quoteAmount);
        if (tokenAmount != 0) IERC20Minimal(address(worldToken)).safeTransfer(recipient, tokenAmount);

        emit ReservesSwept(recipient, quoteAmount, tokenAmount);
    }

    function surplusQuote() external view returns (uint256) {
        uint256 balance = quoteAsset.balanceOf(address(this));
        return balance > trackedQuoteReserve ? balance - trackedQuoteReserve : 0;
    }

    function surplusTokens() external view returns (uint256) {
        if (address(worldToken) == address(0)) return 0;
        uint256 balance = worldToken.balanceOf(address(this));
        return balance > trackedTokenReserve ? balance - trackedTokenReserve : 0;
    }

    function _depositFee(uint256 fee) private {
        quoteAsset.forceApprove(address(rewardVault), fee);
        rewardVault.depositFee(fee);
    }

    function _pullExact(IERC20Minimal asset, address from, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = asset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
    }

    function _requireInitialized() private view {
        if (phase == Phase.Uninitialized) revert NotInitialized();
    }

    function _requireLive() private view {
        if (phase == Phase.Uninitialized) revert NotInitialized();
        if (phase != Phase.CurveLive) revert CurveClosed();
    }
}
