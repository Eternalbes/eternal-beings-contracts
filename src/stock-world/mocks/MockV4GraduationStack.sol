// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStockWorldGraduationCoordinator} from "../IStockWorldGraduationCoordinator.sol";
import {
    IStockWorldPermit2,
    StockWorldV4PoolKey,
    StockWorldV4SwapParams
} from "../interfaces/StockWorldV4Interfaces.sol";
import {IERC20Minimal, SafeERC20} from "../libraries/SafeERC20.sol";

interface IMockStockWorldV4Callbacks {
    function beforeInitialize(address sender, StockWorldV4PoolKey calldata key, uint160 sqrtPriceX96)
        external
        returns (bytes4);

    function beforeSwap(
        address sender,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, int256, uint24);

    function afterSwap(
        address sender,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        int256 delta,
        bytes calldata hookData
    ) external returns (bytes4, int128);
}

contract MockV4PoolManager {
    using SafeERC20 for IERC20Minimal;

    mapping(bytes32 poolId => bool initialized) public initialized;
    StockWorldV4PoolKey public lastKey;
    uint160 public lastSqrtPriceX96;
    address private callbackHook;

    function initialize(StockWorldV4PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        bytes32 poolId = keccak256(abi.encode(key));
        require(!initialized[poolId], "already initialized");
        callbackHook = key.hooks;
        bytes4 response = IMockStockWorldV4Callbacks(key.hooks).beforeInitialize(msg.sender, key, sqrtPriceX96);
        callbackHook = address(0);
        require(response == IMockStockWorldV4Callbacks.beforeInitialize.selector, "before initialize");
        initialized[poolId] = true;
        lastKey = key;
        lastSqrtPriceX96 = sqrtPriceX96;
        return 0;
    }

    function take(address currency, address to, uint256 amount) external {
        require(msg.sender == callbackHook && callbackHook != address(0), "outside callback");
        if (currency == address(0)) {
            (bool success,) = to.call{value: amount}("");
            require(success, "native transfer");
        } else {
            IERC20Minimal(currency).safeTransfer(to, amount);
        }
    }

    function callBeforeSwap(
        address hook,
        address sender,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params
    ) external returns (bytes4 selector, int256 delta, uint24 feeOverride) {
        callbackHook = hook;
        (selector, delta, feeOverride) = IMockStockWorldV4Callbacks(hook).beforeSwap(sender, key, params, "");
        callbackHook = address(0);
    }

    function callAfterSwap(
        address hook,
        address sender,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        int256 balanceDelta
    ) external returns (bytes4 selector, int128 delta) {
        callbackHook = hook;
        (selector, delta) = IMockStockWorldV4Callbacks(hook).afterSwap(sender, key, params, balanceDelta, "");
        callbackHook = address(0);
    }

    function simulateSwap(
        address hook,
        address sender,
        StockWorldV4PoolKey calldata key,
        StockWorldV4SwapParams calldata params,
        int256 balanceDelta
    ) external returns (int256 beforeDelta, int128 afterDelta) {
        callbackHook = hook;
        (bytes4 beforeSelector, int256 collectedBefore,) =
            IMockStockWorldV4Callbacks(hook).beforeSwap(sender, key, params, "");
        require(beforeSelector == IMockStockWorldV4Callbacks.beforeSwap.selector, "before swap");
        (bytes4 afterSelector, int128 collectedAfter) =
            IMockStockWorldV4Callbacks(hook).afterSwap(sender, key, params, balanceDelta, "");
        require(afterSelector == IMockStockWorldV4Callbacks.afterSwap.selector, "after swap");
        callbackHook = address(0);
        return (collectedBefore, collectedAfter);
    }

    receive() external payable {}
}

contract MockV4Permit2 is IStockWorldPermit2 {
    using SafeERC20 for IERC20Minimal;

    struct Allowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => Allowance approval))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage approval = allowance[from][token][msg.sender];
        require(approval.expiration >= block.timestamp && approval.amount >= amount, "permit2 allowance");
        approval.amount -= amount;
        IERC20Minimal(token).safeTransferFrom(from, to, amount);
    }
}

contract MockV4PositionManager {
    address public immutable poolManager;
    address public immutable permit2;
    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => address owner) public ownerOf;

    bool public failMint;
    bytes public lastActions;
    uint128 public lastAmount0Max;
    uint128 public lastAmount1Max;
    uint128 public lastLiquidity;
    int24 public lastTickLower;
    int24 public lastTickUpper;

    constructor(address poolManager_, address permit2_) {
        poolManager = poolManager_;
        permit2 = permit2_;
    }

    function setFailMint(bool failMint_) external {
        failMint = failMint_;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        require(!failMint, "mint rejected");
        require(deadline >= block.timestamp, "deadline");
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"020d") && params.length == 2, "actions");

        (
            StockWorldV4PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint256 liquidity,
            uint128 amount0Max,
            uint128 amount1Max,
            address recipient,
            bytes memory hookData
        ) = abi.decode(params[0], (StockWorldV4PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));
        (address settle0, address settle1) = abi.decode(params[1], (address, address));
        require(settle0 == key.currency0 && settle1 == key.currency1 && hookData.length == 0, "settle pair");
        require(liquidity <= type(uint128).max, "liquidity");

        lastActions = actions;
        lastAmount0Max = amount0Max;
        lastAmount1Max = amount1Max;
        lastLiquidity = uint128(liquidity);
        lastTickLower = tickLower;
        lastTickUpper = tickUpper;

        uint160 amount0Used = uint160(amount0Max - (amount0Max > 1 ? 1 : 0));
        uint160 amount1Used = uint160(amount1Max - (amount1Max > 2 ? 2 : 0));
        if (key.currency0 == address(0)) {
            require(msg.value == amount0Max, "native value");
            (bool funded,) = poolManager.call{value: amount0Used}("");
            require(funded, "native funding");
            uint256 refund = amount0Max - amount0Used;
            if (refund != 0) {
                (bool refunded,) = msg.sender.call{value: refund}("");
                require(refunded, "native refund");
            }
        } else {
            require(msg.value == 0, "unexpected value");
            MockV4Permit2(permit2).transferFrom(msg.sender, poolManager, amount0Used, key.currency0);
        }
        MockV4Permit2(permit2).transferFrom(msg.sender, poolManager, amount1Used, key.currency1);

        uint256 tokenId = nextTokenId++;
        ownerOf[tokenId] = recipient;
    }
}

contract MockStockWorldHookRegistry {
    uint256 public registrationCount;
    mapping(bytes32 poolId => address factory) public factoryOf;
    mapping(bytes32 poolId => uint256 worldId) public worldIdOf;
    mapping(bytes32 poolId => address rewardVault) public rewardVaultOf;

    function beforeInitialize(address, StockWorldV4PoolKey calldata, uint160) external pure returns (bytes4) {
        return IMockStockWorldV4Callbacks.beforeInitialize.selector;
    }

    function registerWorldPool(
        StockWorldV4PoolKey calldata key,
        address factory,
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address rewardVault
    ) external {
        require(worldToken != quoteAsset && rewardVault != address(0), "registration");
        bytes32 poolId = keccak256(abi.encode(key));
        require(factoryOf[poolId] == address(0), "registered");
        registrationCount += 1;
        factoryOf[poolId] = factory;
        worldIdOf[poolId] = worldId;
        rewardVaultOf[poolId] = rewardVault;
    }
}

contract MockV4CanonicalFactory {
    address public immutable graduationCoordinator;
    mapping(uint256 worldId => address worldToken) public canonicalToken;

    constructor(address graduationCoordinator_) {
        graduationCoordinator = graduationCoordinator_;
    }

    function setCanonicalWorld(uint256 worldId, address worldToken) external {
        canonicalToken[worldId] = worldToken;
    }

    function isCanonicalWorld(uint256 worldId, address worldToken) external view returns (bool) {
        return canonicalToken[worldId] == worldToken;
    }

    function callPreflight(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external view {
        IStockWorldGraduationCoordinator(graduationCoordinator).preflight(
            worldId, worldToken, quoteAsset, quoteAmount, tokenAmount
        );
    }

    function callCreate(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address escrow,
        uint256 quoteAmount,
        uint256 totalTokenAmount,
        uint256 poolTokenAmount
    ) external returns (bytes32) {
        return IStockWorldGraduationCoordinator(graduationCoordinator).createPermanentMarket(
            worldId, worldToken, quoteAsset, escrow, quoteAmount, totalTokenAmount, poolTokenAmount
        );
    }
}

contract MockV4RewardVault {
    using SafeERC20 for IERC20Minimal;

    address public immutable quoteAsset;
    uint256 public totalFeesDeposited;

    constructor(address quoteAsset_) {
        quoteAsset = quoteAsset_;
    }

    function depositFee(uint256 amount) external payable {
        if (quoteAsset == address(0)) {
            require(msg.value == amount, "native fee");
        } else {
            require(msg.value == 0, "unexpected value");
            IERC20Minimal quote = IERC20Minimal(quoteAsset);
            uint256 balanceBefore = quote.balanceOf(address(this));
            quote.safeTransferFrom(msg.sender, address(this), amount);
            require(quote.balanceOf(address(this)) - balanceBefore == amount, "inexact fee");
        }
        totalFeesDeposited += amount;
    }
}

contract MockCreate2Deployer {
    function deploy(bytes32 salt, bytes calldata creationCode) external returns (address deployed) {
        bytes memory code = creationCode;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(deployed != address(0), "create2 failed");
    }
}

contract MockV4GraduationEscrow {
    using SafeERC20 for IERC20Minimal;

    address public immutable factory;
    address public immutable coordinator;
    address public immutable worldToken;
    address public immutable quoteAsset;
    address public immutable rewardVault;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    bool public released;

    constructor(address factory_, address coordinator_, address worldToken_, address quoteAsset_, address rewardVault_) {
        factory = factory_;
        coordinator = coordinator_;
        worldToken = worldToken_;
        quoteAsset = quoteAsset_;
        rewardVault = rewardVault_;
    }

    function arm(uint256 quoteAmount, uint256 tokenAmount) external {
        require(!released, "released");
        require(
            _quoteBalance() >= quoteAmount
                && IERC20Minimal(worldToken).balanceOf(address(this)) >= tokenAmount,
            "balance"
        );
        trackedQuote = quoteAmount;
        trackedTokens = tokenAmount;
    }

    function releaseReserves() external returns (uint256 quoteAmount, uint256 tokenAmount) {
        require(msg.sender == coordinator && !released, "release");
        released = true;
        quoteAmount = trackedQuote;
        tokenAmount = trackedTokens;
        trackedQuote = 0;
        trackedTokens = 0;
        if (quoteAsset == address(0)) {
            (bool success,) = coordinator.call{value: quoteAmount}("");
            require(success, "native release");
        } else {
            IERC20Minimal(quoteAsset).safeTransfer(coordinator, quoteAmount);
        }
        IERC20Minimal(worldToken).safeTransfer(coordinator, tokenAmount);
    }

    function forwardReserve(uint256 amount) external {
        require(released && amount != 0, "forward");
        if (quoteAsset == address(0)) {
            IStockWorldGraduationCoordinator(coordinator).onPostGraduationReserve{value: amount}(amount);
        } else {
            IERC20Minimal(quoteAsset).safeTransfer(coordinator, amount);
            IStockWorldGraduationCoordinator(coordinator).onPostGraduationReserve(amount);
        }
    }

    function _quoteBalance() private view returns (uint256) {
        return quoteAsset == address(0) ? address(this).balance : IERC20Minimal(quoteAsset).balanceOf(address(this));
    }

    receive() external payable {}
}
