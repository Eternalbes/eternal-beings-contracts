// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStockWorldGraduationCoordinator} from "./IStockWorldGraduationCoordinator.sol";
import {IERC20SupplyMinimal, StockWorldBondingCurve} from "./StockWorldBondingCurve.sol";
import {StockWorldConfigValidator} from "./StockWorldConfigValidator.sol";
import {StockWorldConstants, StockWorldTypes} from "./StockWorldTypes.sol";
import {StockWorldGraduationEscrow} from "./StockWorldGraduationEscrow.sol";
import {StockWorldLaunchDeployer} from "./StockWorldLaunchDeployer.sol";
import {WorldNFT} from "./WorldNFT.sol";
import {WorldRewardVault} from "./WorldRewardVault.sol";
import {WorldToken} from "./WorldToken.sol";
import {StockWorldGraduationMath} from "./libraries/StockWorldGraduationMath.sol";

/**
 * @title StockWorldFactory
 * @notice Canonical, one-transaction launcher for immutable Stock Worlds.
 * @dev The factory has no owner and no mutable parameters. It can only finish
 *      deterministic setup and coordinate permissionless graduation.
 */
contract StockWorldFactory {
    enum WorldPhase {
        None,
        CurveLive,
        GraduationPrepared,
        Permanent
    }

    struct WorldRecord {
        bytes32 configHash;
        bytes32 marketId;
        address creator;
        address quoteAsset;
        address worldToken;
        address tokenRewardVault;
        address worldRewardVault;
        address bondingCurve;
        address worldNft;
        address fairMintController;
        address graduationEscrow;
        uint256 graduationPoolTokens;
        WorldPhase phase;
    }

    StockWorldConfigValidator public immutable configValidator;
    StockWorldLaunchDeployer public immutable launchDeployer;
    IStockWorldGraduationCoordinator public immutable graduationCoordinator;
    address public immutable platformFeeRecipient;
    uint32 public immutable commitBlocks;
    uint32 public immutable revealBlocks;
    uint32 public immutable claimBlocks;

    uint256 public worldCount;
    mapping(uint256 worldId => WorldRecord world) private worlds;
    mapping(address worldToken => uint256 oneBasedWorldId) public worldIdOfToken;
    mapping(address worldNft => uint256 oneBasedWorldId) public worldIdOfNft;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidMintSchedule();
    error IncorrectLaunchFee();
    error FeeTransferFailed();
    error WorldDoesNotExist();
    error WrongWorldPhase();
    error InvalidGraduationState();
    error InvalidMarketId();
    error ReentrantCall();

    event WorldLaunched(
        uint256 indexed worldId,
        bytes32 indexed configHash,
        address indexed creator,
        address worldToken,
        address worldNft,
        address bondingCurve,
        address fairMintController,
        address worldRewardVault,
        address tokenRewardVault,
        address graduationEscrow
    );
    event GraduationPrepared(
        uint256 indexed worldId, uint256 quoteAmount, uint256 totalTokenAmount, uint256 poolTokenAmount
    );
    event WorldGraduated(uint256 indexed worldId, bytes32 indexed marketId);

    constructor(
        StockWorldConfigValidator configValidator_,
        StockWorldLaunchDeployer launchDeployer_,
        IStockWorldGraduationCoordinator graduationCoordinator_,
        address platformFeeRecipient_,
        uint32 commitBlocks_,
        uint32 revealBlocks_,
        uint32 claimBlocks_
    ) {
        if (
            address(configValidator_) == address(0) || address(launchDeployer_) == address(0)
                || address(graduationCoordinator_) == address(0) || platformFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (
            address(configValidator_).code.length == 0 || address(launchDeployer_).code.length == 0
                || address(graduationCoordinator_).code.length == 0
        ) revert NotContract();
        if (commitBlocks_ == 0 || revealBlocks_ == 0 || claimBlocks_ == 0) revert InvalidMintSchedule();

        configValidator = configValidator_;
        launchDeployer = launchDeployer_;
        graduationCoordinator = graduationCoordinator_;
        platformFeeRecipient = platformFeeRecipient_;
        commitBlocks = commitBlocks_;
        revealBlocks = revealBlocks_;
        claimBlocks = claimBlocks_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function launchWorld(StockWorldTypes.WorldConfig calldata config)
        external
        payable
        nonReentrant
        returns (uint256 worldId, StockWorldTypes.WorldModules memory modules)
    {
        if (msg.value != StockWorldConstants.PLATFORM_LAUNCH_FEE) revert IncorrectLaunchFee();
        bytes32 configHash = configValidator.validateConfig(config);

        uint256 virtualQuoteReserve = calculateVirtualQuoteReserve(config.graduationTarget);
        StockWorldTypes.MintSchedule memory schedule = StockWorldTypes.MintSchedule({
            commitBlocks: commitBlocks,
            revealBlocks: revealBlocks,
            claimBlocks: claimBlocks,
            epochCapacity: calculateEpochCapacity(config.nftMaxSupply),
            walletLimit: StockWorldConstants.DEFAULT_NFT_WALLET_LIMIT
        });

        modules = launchDeployer.deployWorld(
            config, schedule, address(graduationCoordinator), virtualQuoteReserve
        );

        WorldToken(modules.worldToken).transfer(
            modules.bondingCurve, StockWorldConstants.WORLD_TOKEN_SUPPLY
        );
        StockWorldBondingCurve(modules.bondingCurve).initialize(IERC20SupplyMinimal(modules.worldToken));
        WorldNFT(modules.worldNft).setMintController(modules.fairMintController);
        WorldRewardVault(modules.worldRewardVault).bindWorldModules(
            modules.worldNft, modules.graduationEscrow
        );

        worldId = worldCount++;
        worlds[worldId] = WorldRecord({
            configHash: configHash,
            marketId: bytes32(0),
            creator: config.creator,
            quoteAsset: config.quoteAsset,
            worldToken: modules.worldToken,
            tokenRewardVault: modules.tokenRewardVault,
            worldRewardVault: modules.worldRewardVault,
            bondingCurve: modules.bondingCurve,
            worldNft: modules.worldNft,
            fairMintController: modules.fairMintController,
            graduationEscrow: modules.graduationEscrow,
            graduationPoolTokens: 0,
            phase: WorldPhase.CurveLive
        });
        worldIdOfToken[modules.worldToken] = worldId + 1;
        worldIdOfNft[modules.worldNft] = worldId + 1;

        (bool paid,) = platformFeeRecipient.call{value: msg.value}("");
        if (!paid) revert FeeTransferFailed();

        emit WorldLaunched(
            worldId,
            configHash,
            config.creator,
            modules.worldToken,
            modules.worldNft,
            modules.bondingCurve,
            modules.fairMintController,
            modules.worldRewardVault,
            modules.tokenRewardVault,
            modules.graduationEscrow
        );
    }

    function prepareGraduation(uint256 worldId) external nonReentrant {
        WorldRecord storage world = _world(worldId);
        if (world.phase != WorldPhase.CurveLive) revert WrongWorldPhase();

        StockWorldBondingCurve curve = StockWorldBondingCurve(world.bondingCurve);
        if (!curve.readyToGraduate()) revert InvalidGraduationState();

        WorldRewardVault rewardVault = WorldRewardVault(world.worldRewardVault);
        rewardVault.commitZeroWeightReserves();

        uint256 curveQuote = curve.trackedQuoteReserve();
        uint256 curveTokens = curve.trackedTokenReserve();
        uint256 virtualQuoteReserve = curve.virtualQuoteReserve();
        uint256 availableRewardQuote = rewardVault.liquidityReserve();
        uint256 rewardQuote = availableRewardQuote < virtualQuoteReserve ? availableRewardQuote : virtualQuoteReserve;
        uint256 totalQuote = curveQuote + rewardQuote;
        uint256 poolTokenAmount = StockWorldGraduationMath.poolTokenAmount(
            curveTokens, curveQuote, rewardQuote, virtualQuoteReserve
        );

        graduationCoordinator.preflight(
            worldId, world.worldToken, world.quoteAsset, totalQuote, poolTokenAmount
        );

        (uint256 sweptQuote, uint256 sweptTokens) =
            curve.sweepForGraduation(world.graduationEscrow);
        if (sweptQuote != curveQuote || sweptTokens != curveTokens) revert InvalidGraduationState();

        StockWorldGraduationEscrow escrow = StockWorldGraduationEscrow(payable(world.graduationEscrow));
        escrow.recordCurveSweep(sweptQuote, sweptTokens);
        if (rewardQuote != 0 && escrow.collectRewardReserve(rewardQuote) != rewardQuote) {
            revert InvalidGraduationState();
        }
        if (escrow.trackedQuote() != totalQuote || escrow.trackedTokens() != curveTokens) {
            revert InvalidGraduationState();
        }

        world.graduationPoolTokens = poolTokenAmount;
        world.phase = WorldPhase.GraduationPrepared;
        emit GraduationPrepared(worldId, totalQuote, curveTokens, poolTokenAmount);
    }

    function completeGraduation(uint256 worldId) external nonReentrant returns (bytes32 marketId) {
        WorldRecord storage world = _world(worldId);
        if (world.phase != WorldPhase.GraduationPrepared) revert WrongWorldPhase();

        StockWorldGraduationEscrow escrow = StockWorldGraduationEscrow(payable(world.graduationEscrow));
        uint256 quoteAmount = escrow.trackedQuote();
        uint256 tokenAmount = escrow.trackedTokens();
        escrow.armRelease();

        marketId = graduationCoordinator.createPermanentMarket(
            worldId,
            world.worldToken,
            world.quoteAsset,
            world.graduationEscrow,
            quoteAmount,
            tokenAmount,
            world.graduationPoolTokens
        );
        if (marketId == bytes32(0)) revert InvalidMarketId();
        if (!escrow.released() || escrow.trackedQuote() != 0 || escrow.trackedTokens() != 0) {
            revert InvalidGraduationState();
        }

        world.marketId = marketId;
        world.phase = WorldPhase.Permanent;
        emit WorldGraduated(worldId, marketId);
    }

    function getWorld(uint256 worldId) external view returns (WorldRecord memory) {
        return _world(worldId);
    }

    function isCanonicalWorld(uint256 worldId, address worldToken) external view returns (bool) {
        return worldId < worldCount && worlds[worldId].worldToken == worldToken;
    }

    function calculateVirtualQuoteReserve(uint256 graduationTarget) public pure returns (uint256) {
        if (graduationTarget == 0) return 0;
        return graduationTarget / 9 + (graduationTarget % 9 == 0 ? 0 : 1);
    }

    function calculateEpochCapacity(uint32 nftMaxSupply) public pure returns (uint32) {
        uint32 epochs = StockWorldConstants.MINT_DISTRIBUTION_EPOCHS;
        return nftMaxSupply / epochs + (nftMaxSupply % epochs == 0 ? 0 : 1);
    }

    function _world(uint256 worldId) private view returns (WorldRecord storage world) {
        if (worldId >= worldCount) revert WorldDoesNotExist();
        world = worlds[worldId];
    }
}
