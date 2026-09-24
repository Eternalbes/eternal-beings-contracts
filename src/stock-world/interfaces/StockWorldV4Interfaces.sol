// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct StockWorldV4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct StockWorldV4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IStockWorldV4PoolManager {
    function initialize(StockWorldV4PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function take(address currency, address to, uint256 amount) external;
}

interface IStockWorldV4PositionManager {
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IStockWorldPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IStockWorldHookRegistry {
    function registerWorldPool(
        StockWorldV4PoolKey calldata key,
        address factory,
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address rewardVault
    ) external;
}

interface IStockWorldHookCoordinator {
    function poolManager() external view returns (address);
    function worldHook() external view returns (address);
    function factory() external view returns (address);
}

interface IStockWorldRewardVaultSink {
    function quoteAsset() external view returns (address);
    function depositFee(uint256 amount) external payable;
}

interface IStockWorldCanonicalFactory {
    function graduationCoordinator() external view returns (address);
    function isCanonicalWorld(uint256 worldId, address worldToken) external view returns (bool);
}

interface IStockWorldGraduationEscrowV4 {
    function factory() external view returns (address);
    function coordinator() external view returns (address);
    function worldToken() external view returns (address);
    function quoteAsset() external view returns (address);
    function rewardVault() external view returns (address);
    function trackedQuote() external view returns (uint256);
    function trackedTokens() external view returns (uint256);
    function releaseReserves() external returns (uint256 quoteAmount, uint256 tokenAmount);
}

interface IStockWorldPermanentLocker {
    function positionManager() external view returns (address);
    function lockPosition(address factory, uint256 worldId, address worldToken, uint256 positionId) external;
    function lockTokenSupply(address factory, uint256 worldId, address worldToken, uint256 amount) external;
}
