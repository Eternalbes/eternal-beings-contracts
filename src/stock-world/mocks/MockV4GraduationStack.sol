// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStockWorldGraduationCoordinator} from "../IStockWorldGraduationCoordinator.sol";
import {
    IStockWorldPermit2,
    StockWorldV4PoolKey
} from "../interfaces/StockWorldV4Interfaces.sol";
import {IERC20Minimal, SafeERC20} from "../libraries/SafeERC20.sol";

contract MockV4PoolManager {
    mapping(bytes32 poolId => bool initialized) public initialized;
    StockWorldV4PoolKey public lastKey;
    uint160 public lastSqrtPriceX96;

    function initialize(StockWorldV4PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        bytes32 poolId = keccak256(abi.encode(key));
        require(!initialized[poolId], "already initialized");
        initialized[poolId] = true;
        lastKey = key;
        lastSqrtPriceX96 = sqrtPriceX96;
        return 0;
    }
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
        MockV4Permit2(permit2).transferFrom(msg.sender, poolManager, amount0Used, key.currency0);
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
    address public immutable quoteAsset;

    constructor(address quoteAsset_) {
        quoteAsset = quoteAsset_;
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
            IERC20Minimal(quoteAsset).balanceOf(address(this)) >= quoteAmount
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
        IERC20Minimal(quoteAsset).safeTransfer(coordinator, quoteAmount);
        IERC20Minimal(worldToken).safeTransfer(coordinator, tokenAmount);
    }

    function forwardReserve(uint256 amount) external {
        require(released && amount != 0, "forward");
        IERC20Minimal(quoteAsset).safeTransfer(coordinator, amount);
        IStockWorldGraduationCoordinator(coordinator).onPostGraduationReserve(amount);
    }
}
