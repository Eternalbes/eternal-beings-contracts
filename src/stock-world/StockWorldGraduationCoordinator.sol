// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStockWorldGraduationCoordinator} from "./IStockWorldGraduationCoordinator.sol";
import {StockWorldGraduationExecutor} from "./StockWorldGraduationExecutor.sol";
import {StockWorldGraduationGuard} from "./StockWorldGraduationGuard.sol";
import {
    IStockWorldCanonicalFactory,
    IStockWorldGraduationEscrowV4,
    IStockWorldHookRegistry,
    IStockWorldPermanentLocker,
    IStockWorldPermit2,
    IStockWorldV4PoolManager,
    IStockWorldV4PositionManager,
    StockWorldV4PoolKey
} from "./interfaces/StockWorldV4Interfaces.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title StockWorldGraduationCoordinator
 * @notice Creates and permanently locks a Stock World's Uniswap v4 market.
 * @dev External protocol addresses, fee, and tick spacing are immutable. The
 *      canonical factory can be bound exactly once by the deployment binder;
 *      after binding, no administrative mutation path remains.
 */
contract StockWorldGraduationCoordinator is IStockWorldGraduationCoordinator {
    using SafeERC20 for IERC20Minimal;

    struct MarketRecord {
        bytes32 marketId;
        address factory;
        uint256 worldId;
        address worldToken;
        address quoteAsset;
        address rewardVault;
        address graduationEscrow;
        uint256 positionId;
    }

    IStockWorldV4PoolManager public immutable poolManager;
    IStockWorldV4PositionManager public immutable positionManager;
    IStockWorldPermit2 public immutable permit2;
    IStockWorldHookRegistry public immutable worldHook;
    StockWorldGraduationGuard public immutable graduationGuard;
    IStockWorldPermanentLocker public immutable locker;
    StockWorldGraduationExecutor public immutable executor;
    address public immutable factoryBinder;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    address public factory;
    mapping(bytes32 worldKey => MarketRecord market) private markets;
    mapping(address escrow => bytes32 worldKey) public worldKeyOfEscrow;
    mapping(address escrow => uint256 amount) public pendingQuoteByEscrow;
    mapping(address quoteAsset => uint256 amount) public totalPendingQuoteByAsset;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidPoolParameters();
    error InvalidExternalWiring();
    error NotFactoryBinder();
    error FactoryAlreadyBound();
    error InvalidFactory();
    error NotFactory();
    error NotCanonicalWorld();
    error InvalidGraduationState();
    error MarketAlreadyCreated();
    error UnsupportedTokenBehavior();
    error UnregisteredEscrow();
    error ReentrantCall();

    event FactoryBound(address indexed factory);
    event PermanentMarketCreated(
        bytes32 indexed marketId,
        address indexed factory,
        uint256 indexed worldId,
        address worldToken,
        address quoteAsset,
        uint256 positionId,
        uint256 quoteAmount,
        uint256 poolTokenAmount,
        uint256 permanentlyLockedTokens
    );
    event PendingQuoteRecorded(address indexed escrow, address indexed quoteAsset, uint256 amount, uint256 total);

    constructor(
        IStockWorldV4PoolManager poolManager_,
        IStockWorldV4PositionManager positionManager_,
        IStockWorldPermit2 permit2_,
        IStockWorldHookRegistry worldHook_,
        StockWorldGraduationGuard graduationGuard_,
        IStockWorldPermanentLocker locker_,
        address factoryBinder_,
        uint24 poolFee_,
        int24 tickSpacing_
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || address(worldHook_) == address(0)
                || address(graduationGuard_) == address(0) || address(locker_) == address(0)
                || factoryBinder_ == address(0)
        ) revert ZeroAddress();
        if (
            address(poolManager_).code.length == 0 || address(positionManager_).code.length == 0
                || address(permit2_).code.length == 0 || address(worldHook_).code.length == 0
                || address(graduationGuard_).code.length == 0 || address(locker_).code.length == 0
        ) revert NotContract();
        // The permanent LP is ownerless, so a non-zero core fee would accrue
        // value that nobody can collect. All permanent-market fees are routed
        // through StockWorldHook instead.
        if (poolFee_ != 0 || tickSpacing_ < 1 || tickSpacing_ > type(int16).max) {
            revert InvalidPoolParameters();
        }
        if (
            positionManager_.poolManager() != address(poolManager_)
                || positionManager_.permit2() != address(permit2_)
                || locker_.positionManager() != address(positionManager_)
        ) revert InvalidExternalWiring();

        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        worldHook = worldHook_;
        graduationGuard = graduationGuard_;
        locker = locker_;
        factoryBinder = factoryBinder_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        executor = new StockWorldGraduationExecutor(positionManager_, permit2_, address(this));
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != factoryBinder) revert NotFactoryBinder();
        if (factory != address(0)) revert FactoryAlreadyBound();
        if (factory_ == address(0) || factory_.code.length == 0) revert InvalidFactory();
        if (IStockWorldCanonicalFactory(factory_).graduationCoordinator() != address(this)) {
            revert InvalidFactory();
        }
        factory = factory_;
        emit FactoryBound(factory_);
    }

    function preflight(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external view {
        _assertFactoryWorld(worldId, worldToken);
        graduationGuard.assertSeedable(worldToken, quoteAsset, tickSpacing, quoteAmount, tokenAmount);
    }

    function createPermanentMarket(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address graduationEscrow,
        uint256 quoteAmount,
        uint256 totalTokenAmount,
        uint256 poolTokenAmount
    ) external nonReentrant returns (bytes32 marketId) {
        _assertFactoryWorld(worldId, worldToken);
        bytes32 key = worldKey(msg.sender, worldId);
        if (markets[key].marketId != bytes32(0)) revert MarketAlreadyCreated();
        if (
            graduationEscrow == address(0) || graduationEscrow.code.length == 0 || quoteAmount == 0
                || poolTokenAmount == 0 || totalTokenAmount < poolTokenAmount
        ) revert InvalidGraduationState();

        IStockWorldGraduationEscrowV4 escrow = IStockWorldGraduationEscrowV4(graduationEscrow);
        address rewardVault = escrow.rewardVault();
        if (
            escrow.factory() != msg.sender || escrow.coordinator() != address(this)
                || escrow.worldToken() != worldToken || escrow.quoteAsset() != quoteAsset
                || rewardVault == address(0) || rewardVault.code.length == 0
                || escrow.trackedQuote() != quoteAmount || escrow.trackedTokens() != totalTokenAmount
        ) revert InvalidGraduationState();

        (uint160 sqrtPriceX96, uint128 liquidity) = graduationGuard.assertSeedable(
            worldToken, quoteAsset, tickSpacing, quoteAmount, poolTokenAmount
        );
        uint256 quoteBaseline = IERC20Minimal(quoteAsset).balanceOf(address(this));
        uint256 tokenBaseline = IERC20Minimal(worldToken).balanceOf(address(this));
        (uint256 releasedQuote, uint256 releasedTokens) = escrow.releaseReserves();
        if (
            releasedQuote != quoteAmount || releasedTokens != totalTokenAmount
                || IERC20Minimal(quoteAsset).balanceOf(address(this)) - quoteBaseline != quoteAmount
                || IERC20Minimal(worldToken).balanceOf(address(this)) - tokenBaseline != totalTokenAmount
        ) revert UnsupportedTokenBehavior();

        StockWorldV4PoolKey memory poolKey = _poolKey(worldToken, quoteAsset);
        marketId = keccak256(abi.encode(poolKey));
        if (marketId == bytes32(0)) revert InvalidGraduationState();
        poolManager.initialize(poolKey, sqrtPriceX96);
        worldHook.registerWorldPool(poolKey, msg.sender, worldId, worldToken, quoteAsset, rewardVault);

        uint256 lockedBeforeMint = totalTokenAmount - poolTokenAmount;
        if (lockedBeforeMint != 0) _lockTokens(msg.sender, worldId, worldToken, lockedBeforeMint);

        (uint128 amount0, uint128 amount1) = quoteAsset < worldToken
            ? (uint128(quoteAmount), uint128(poolTokenAmount))
            : (uint128(poolTokenAmount), uint128(quoteAmount));
        uint256 positionId = positionManager.nextTokenId();
        IERC20Minimal(poolKey.currency0).forceApprove(address(executor), amount0);
        IERC20Minimal(poolKey.currency1).forceApprove(address(executor), amount1);
        executor.mintFullRangePosition(
            StockWorldGraduationExecutor.MintRequest({
                key: poolKey,
                tickLower: (-887272 / tickSpacing) * tickSpacing,
                tickUpper: (887272 / tickSpacing) * tickSpacing,
                liquidity: liquidity,
                amount0Max: amount0,
                amount1Max: amount1,
                recipient: address(locker)
            })
        );
        IERC20Minimal(poolKey.currency0).forceApprove(address(executor), 0);
        IERC20Minimal(poolKey.currency1).forceApprove(address(executor), 0);

        locker.lockPosition(msg.sender, worldId, worldToken, positionId);
        uint256 tokenAfterMint = IERC20Minimal(worldToken).balanceOf(address(this));
        if (tokenAfterMint < tokenBaseline) revert UnsupportedTokenBehavior();
        uint256 tokenDust = tokenAfterMint - tokenBaseline;
        if (tokenDust != 0) _lockTokens(msg.sender, worldId, worldToken, tokenDust);

        markets[key] = MarketRecord({
            marketId: marketId,
            factory: msg.sender,
            worldId: worldId,
            worldToken: worldToken,
            quoteAsset: quoteAsset,
            rewardVault: rewardVault,
            graduationEscrow: graduationEscrow,
            positionId: positionId
        });
        worldKeyOfEscrow[graduationEscrow] = key;

        uint256 quoteAfterMint = IERC20Minimal(quoteAsset).balanceOf(address(this));
        if (quoteAfterMint < quoteBaseline) revert UnsupportedTokenBehavior();
        uint256 quoteDust = quoteAfterMint - quoteBaseline;
        if (quoteDust != 0) _recordPendingQuote(graduationEscrow, quoteAsset, quoteDust);
        if (IERC20Minimal(worldToken).balanceOf(address(this)) != tokenBaseline) {
            revert UnsupportedTokenBehavior();
        }

        emit PermanentMarketCreated(
            marketId,
            msg.sender,
            worldId,
            worldToken,
            quoteAsset,
            positionId,
            quoteAmount,
            poolTokenAmount,
            lockedBeforeMint + tokenDust
        );
    }

    function onPostGraduationReserve(uint256 amount) external nonReentrant {
        bytes32 key = worldKeyOfEscrow[msg.sender];
        MarketRecord storage market = markets[key];
        if (amount == 0 || market.graduationEscrow != msg.sender) revert UnregisteredEscrow();
        IERC20Minimal quote = IERC20Minimal(market.quoteAsset);
        uint256 requiredBalance = totalPendingQuoteByAsset[market.quoteAsset] + amount;
        if (quote.balanceOf(address(this)) < requiredBalance) revert UnsupportedTokenBehavior();
        _recordPendingQuote(msg.sender, market.quoteAsset, amount);
    }

    function getMarket(address factory_, uint256 worldId) external view returns (MarketRecord memory) {
        return markets[worldKey(factory_, worldId)];
    }

    function worldKey(address factory_, uint256 worldId) public pure returns (bytes32) {
        return keccak256(abi.encode(factory_, worldId));
    }

    function _poolKey(address worldToken, address quoteAsset) private view returns (StockWorldV4PoolKey memory key) {
        (address currency0, address currency1) = worldToken < quoteAsset
            ? (worldToken, quoteAsset)
            : (quoteAsset, worldToken);
        key = StockWorldV4PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: address(worldHook)
        });
    }

    function _assertFactoryWorld(uint256 worldId, address worldToken) private view {
        address canonicalFactory = factory;
        if (msg.sender != canonicalFactory || canonicalFactory == address(0)) revert NotFactory();
        if (!IStockWorldCanonicalFactory(canonicalFactory).isCanonicalWorld(worldId, worldToken)) {
            revert NotCanonicalWorld();
        }
    }

    function _lockTokens(address factory_, uint256 worldId, address worldToken, uint256 amount) private {
        IERC20Minimal token = IERC20Minimal(worldToken);
        token.forceApprove(address(locker), amount);
        locker.lockTokenSupply(factory_, worldId, worldToken, amount);
        token.forceApprove(address(locker), 0);
    }

    function _recordPendingQuote(address escrow, address quoteAsset, uint256 amount) private {
        uint256 updated = pendingQuoteByEscrow[escrow] + amount;
        pendingQuoteByEscrow[escrow] = updated;
        totalPendingQuoteByAsset[quoteAsset] += amount;
        emit PendingQuoteRecorded(escrow, quoteAsset, amount, updated);
    }
}
