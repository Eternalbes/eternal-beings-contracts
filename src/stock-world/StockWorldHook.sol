// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldConstants} from "./StockWorldTypes.sol";
import {
    IStockWorldCanonicalFactory,
    IStockWorldHookCoordinator,
    IStockWorldRewardVaultSink,
    IStockWorldV4PoolManager,
    StockWorldV4PoolKey,
    StockWorldV4SwapParams
} from "./interfaces/StockWorldV4Interfaces.sol";
import {FullMath} from "./libraries/FullMath.sol";
import {QuoteAssetLib} from "./libraries/QuoteAssetLib.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title StockWorldHook
 * @notice Autonomous Uniswap v4 fee hook shared by every permanent Stock World.
 * @dev The hook charges only the World's native-ETH or ERC-20 quote asset. It never holds or
 *      converts World Token fees, so permissionless sweeps require no oracle,
 *      keeper-selected price, or administrator. Its CREATE2 address must encode
 *      beforeInitialize, beforeSwap, afterSwap, and both return-delta flags.
 */
contract StockWorldHook {
    using SafeERC20 for IERC20Minimal;

    uint160 public constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 public constant REQUIRED_HOOK_FLAGS =
        (1 << 13) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2);
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant HOOK_FEE_BPS = StockWorldConstants.BASE_TRADING_FEE_BPS;

    struct PoolRecord {
        bool registered;
        bool worldTokenIsCurrency0;
        address factory;
        uint256 worldId;
        address worldToken;
        address quoteAsset;
        address rewardVault;
    }

    IStockWorldV4PoolManager public immutable poolManager;
    address public immutable coordinatorBinder;
    address public coordinator;

    mapping(bytes32 poolId => PoolRecord pool) private pools;
    mapping(bytes32 poolId => uint256 amount) public pendingQuote;
    mapping(address quoteAsset => uint256 amount) public totalPendingQuoteByAsset;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidHookAddress();
    error NotCoordinatorBinder();
    error CoordinatorAlreadyBound();
    error InvalidCoordinator();
    error NotPoolManager();
    error NotCoordinator();
    error InvalidPoolKey();
    error PoolAlreadyRegistered();
    error UnknownPool();
    error FeeAmountOverflow();
    error PartialSpecifiedFill();
    error UnsupportedTokenBehavior();
    error NothingToSweep();
    error ReentrantCall();

    event CoordinatorBound(address indexed coordinator);
    event WorldPoolRegistered(
        bytes32 indexed poolId,
        address indexed factory,
        uint256 indexed worldId,
        address worldToken,
        address quoteAsset,
        address rewardVault
    );
    event QuoteFeeCollected(bytes32 indexed poolId, address indexed quoteAsset, uint256 amount);
    event QuoteFeesSwept(bytes32 indexed poolId, address indexed rewardVault, uint256 amount);

    constructor(IStockWorldV4PoolManager poolManager_, address coordinatorBinder_) {
        if (address(poolManager_) == address(0) || coordinatorBinder_ == address(0)) revert ZeroAddress();
        if (address(poolManager_).code.length == 0) revert NotContract();
        if ((uint160(address(this)) & ALL_HOOK_MASK) != REQUIRED_HOOK_FLAGS) revert InvalidHookAddress();
        poolManager = poolManager_;
        coordinatorBinder = coordinatorBinder_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    receive() external payable {}

    function bindCoordinator(address coordinator_) external {
        if (msg.sender != coordinatorBinder) revert NotCoordinatorBinder();
        if (coordinator != address(0)) revert CoordinatorAlreadyBound();
        if (coordinator_ == address(0) || coordinator_.code.length == 0) revert InvalidCoordinator();

        IStockWorldHookCoordinator candidate = IStockWorldHookCoordinator(coordinator_);
        if (candidate.poolManager() != address(poolManager) || candidate.worldHook() != address(this)) {
            revert InvalidCoordinator();
        }
        coordinator = coordinator_;
        emit CoordinatorBound(coordinator_);
    }

    function registerWorldPool(
        StockWorldV4PoolKey calldata key,
        address factory,
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address rewardVault
    ) external {
        if (msg.sender != coordinator || coordinator == address(0)) revert NotCoordinator();
        if (
            key.hooks != address(this) || key.currency1 == address(0) || key.currency0 >= key.currency1
                || key.fee != 0 || worldToken == address(0) || worldToken == quoteAsset
                || rewardVault == address(0) || rewardVault.code.length == 0
        ) revert InvalidPoolKey();

        bool worldTokenIsCurrency0 = key.currency0 == worldToken;
        if (
            (!worldTokenIsCurrency0 && key.currency1 != worldToken)
                || (worldTokenIsCurrency0 ? key.currency1 : key.currency0) != quoteAsset
                || IStockWorldRewardVaultSink(rewardVault).quoteAsset() != quoteAsset
        ) revert InvalidPoolKey();

        IStockWorldHookCoordinator boundCoordinator = IStockWorldHookCoordinator(coordinator);
        if (
            factory == address(0) || factory != boundCoordinator.factory()
                || !IStockWorldCanonicalFactory(factory).isCanonicalWorld(worldId, worldToken)
        ) revert InvalidPoolKey();

        bytes32 poolId = poolIdOf(key);
        if (pools[poolId].registered) revert PoolAlreadyRegistered();
        pools[poolId] = PoolRecord({
            registered: true,
            worldTokenIsCurrency0: worldTokenIsCurrency0,
            factory: factory,
            worldId: worldId,
            worldToken: worldToken,
            quoteAsset: quoteAsset,
            rewardVault: rewardVault
        });
        emit WorldPoolRegistered(poolId, factory, worldId, worldToken, quoteAsset, rewardVault);
    }

    function beforeInitialize(address sender, StockWorldV4PoolKey calldata key, uint160)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (sender != coordinator || coordinator == address(0) || key.hooks != address(this)) {
            revert NotCoordinator();
        }
        return this.beforeInitialize.selector;
    }

    function beforeSwap(
        address,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        bytes calldata
    ) external nonReentrant returns (bytes4, int256 beforeSwapDelta, uint24 lpFeeOverride) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bytes32 poolId = poolIdOf(key);
        PoolRecord memory pool = pools[poolId];
        if (!pool.registered) revert UnknownPool();

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        address specifiedCurrency = specifiedIsCurrency0 ? key.currency0 : key.currency1;
        if (specifiedCurrency != pool.quoteAsset) return (this.beforeSwap.selector, 0, 0);

        uint256 specifiedAmount = _absolute(params.amountSpecified);
        uint256 fee = params.amountSpecified < 0 ? _feeFromGross(specifiedAmount) : _feeOnTop(specifiedAmount);
        if (fee != 0) {
            _takeAndRecord(poolId, pool.quoteAsset, fee);
            beforeSwapDelta = _packBeforeSwapDelta(_toInt128(fee), 0);
        }
        return (this.beforeSwap.selector, beforeSwapDelta, 0);
    }

    function afterSwap(
        address,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        int256 balanceDelta,
        bytes calldata
    ) external nonReentrant returns (bytes4, int128 afterSwapDelta) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bytes32 poolId = poolIdOf(key);
        PoolRecord memory pool = pools[poolId];
        if (!pool.registered) revert UnknownPool();

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        int128 specifiedDelta = specifiedIsCurrency0 ? _amount0(balanceDelta) : _amount1(balanceDelta);
        address specifiedCurrency = specifiedIsCurrency0 ? key.currency0 : key.currency1;
        if (specifiedCurrency == pool.quoteAsset) {
            _assertFullSpecifiedFill(params.amountSpecified, specifiedDelta);
            return (this.afterSwap.selector, 0);
        }

        address unspecifiedCurrency = specifiedIsCurrency0 ? key.currency1 : key.currency0;
        if (unspecifiedCurrency != pool.quoteAsset) revert InvalidPoolKey();
        int128 unspecifiedDelta = specifiedIsCurrency0 ? _amount1(balanceDelta) : _amount0(balanceDelta);
        if (unspecifiedDelta == 0) return (this.afterSwap.selector, 0);

        uint256 amount = _absolute128(unspecifiedDelta);
        uint256 fee = unspecifiedDelta > 0 ? _feeFromGross(amount) : _feeOnTop(amount);
        if (fee != 0) {
            _takeAndRecord(poolId, pool.quoteAsset, fee);
            afterSwapDelta = _toInt128(fee);
        }
        return (this.afterSwap.selector, afterSwapDelta);
    }

    function sweepPoolFees(bytes32 poolId) external nonReentrant returns (uint256 amount) {
        PoolRecord memory pool = pools[poolId];
        if (!pool.registered) revert UnknownPool();
        amount = pendingQuote[poolId];
        if (amount == 0) revert NothingToSweep();

        uint256 totalPending = totalPendingQuoteByAsset[pool.quoteAsset];
        uint256 balanceBefore = QuoteAssetLib.balanceOf(pool.quoteAsset, address(this));
        if (balanceBefore < totalPending) revert UnsupportedTokenBehavior();

        pendingQuote[poolId] = 0;
        totalPendingQuoteByAsset[pool.quoteAsset] = totalPending - amount;
        if (pool.quoteAsset == address(0)) {
            IStockWorldRewardVaultSink(pool.rewardVault).depositFee{value: amount}(amount);
        } else {
            IERC20Minimal quote = IERC20Minimal(pool.quoteAsset);
            quote.forceApprove(pool.rewardVault, amount);
            IStockWorldRewardVaultSink(pool.rewardVault).depositFee(amount);
            quote.forceApprove(pool.rewardVault, 0);
        }
        if (QuoteAssetLib.balanceOf(pool.quoteAsset, address(this)) != balanceBefore - amount) {
            revert UnsupportedTokenBehavior();
        }

        emit QuoteFeesSwept(poolId, pool.rewardVault, amount);
    }

    function getPool(bytes32 poolId) external view returns (PoolRecord memory) {
        return pools[poolId];
    }

    function poolIdOf(StockWorldV4PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function hookPermissionsValid() external view returns (bool) {
        return (uint160(address(this)) & ALL_HOOK_MASK) == REQUIRED_HOOK_FLAGS;
    }

    function _assertFullSpecifiedFill(int256 requested, int128 actual) private pure {
        uint256 amount = _absolute(requested);
        uint256 fee = requested < 0 ? _feeFromGross(amount) : _feeOnTop(amount);
        int256 expected = requested < 0 ? -int256(amount - fee) : int256(amount + fee);
        if (int256(actual) != expected) revert PartialSpecifiedFill();
    }

    function _takeAndRecord(bytes32 poolId, address quoteAsset, uint256 amount) private {
        uint256 balanceBefore = QuoteAssetLib.balanceOf(quoteAsset, address(this));
        poolManager.take(quoteAsset, address(this), amount);
        uint256 balanceAfter = QuoteAssetLib.balanceOf(quoteAsset, address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
        pendingQuote[poolId] += amount;
        totalPendingQuoteByAsset[quoteAsset] += amount;
        emit QuoteFeeCollected(poolId, quoteAsset, amount);
    }

    function _feeFromGross(uint256 grossAmount) private pure returns (uint256) {
        return FullMath.mulDiv(grossAmount, HOOK_FEE_BPS, BPS_DENOMINATOR);
    }

    function _feeOnTop(uint256 netAmount) private pure returns (uint256) {
        return FullMath.mulDivRoundingUp(netAmount, HOOK_FEE_BPS, BPS_DENOMINATOR - HOOK_FEE_BPS);
    }

    function _absolute(int256 value) private pure returns (uint256) {
        if (value == type(int256).min) revert FeeAmountOverflow();
        return uint256(value < 0 ? -value : value);
    }

    function _absolute128(int128 value) private pure returns (uint256) {
        if (value == type(int128).min) revert FeeAmountOverflow();
        return uint256(uint128(value < 0 ? -value : value));
    }

    function _toInt128(uint256 value) private pure returns (int128) {
        if (value > uint256(uint128(type(int128).max))) revert FeeAmountOverflow();
        return int128(uint128(value));
    }

    function _packBeforeSwapDelta(int128 specified, int128 unspecified) private pure returns (int256 packed) {
        assembly ("memory-safe") {
            packed := or(shl(128, specified), and(sub(shl(128, 1), 1), unspecified))
        }
    }

    function _amount0(int256 delta) private pure returns (int128 amount) {
        assembly ("memory-safe") {
            amount := sar(128, delta)
        }
    }

    function _amount1(int256 delta) private pure returns (int128 amount) {
        assembly ("memory-safe") {
            amount := signextend(15, delta)
        }
    }
}
