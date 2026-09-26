// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteAssetRegistry} from "./IQuoteAssetRegistry.sol";
import {StockWorldConstants, StockWorldTypes} from "./StockWorldTypes.sol";

/**
 * @title StockWorldConfigValidator
 * @notice Canonical launch-configuration checks shared by the future factory.
 */
contract StockWorldConfigValidator {
    IQuoteAssetRegistry public immutable quoteAssetRegistry;

    uint256 public constant WORLD_TOKEN_SUPPLY = StockWorldConstants.WORLD_TOKEN_SUPPLY;
    uint256 public constant PLATFORM_LAUNCH_FEE = StockWorldConstants.PLATFORM_LAUNCH_FEE;
    uint32 public constant MIN_NFT_SUPPLY = StockWorldConstants.MIN_NFT_SUPPLY;
    uint32 public constant MAX_NFT_SUPPLY = StockWorldConstants.MAX_NFT_SUPPLY;
    uint16 public constant BASE_TRADING_FEE_BPS = StockWorldConstants.BASE_TRADING_FEE_BPS;
    uint16 public constant MAX_CREATOR_BPS = StockWorldConstants.MAX_CREATOR_BPS;
    uint256 public constant MAX_GRADUATION_TARGET = StockWorldConstants.MAX_GRADUATION_TARGET;

    error ZeroAddress();
    error InvalidName();
    error InvalidSymbol();
    error UnsupportedQuoteAsset();
    error InvalidGraduationTarget();
    error InvalidNftSupply();
    error InvalidMintDifficulty();
    error InvalidMintSchedule();
    error EmptyParticipantAllocation();
    error CreatorAllocationTooHigh();
    error InvalidFeeAllocation();
    error InvalidVisualSeed();
    error InvalidImageURI();
    error UnsupportedRenderMode();

    constructor(IQuoteAssetRegistry quoteAssetRegistry_) {
        if (address(quoteAssetRegistry_) == address(0)) revert ZeroAddress();
        quoteAssetRegistry = quoteAssetRegistry_;
    }

    function validateConfig(StockWorldTypes.WorldConfig calldata config) external view returns (bytes32 configHash) {
        _validate(config);
        return _hash(config);
    }

    function hashConfig(StockWorldTypes.WorldConfig calldata config) external pure returns (bytes32) {
        return _hash(config);
    }

    function _validate(StockWorldTypes.WorldConfig calldata config) private view {
        uint256 nameLength = bytes(config.name).length;
        if (nameLength == 0 || nameLength > 64) revert InvalidName();
        for (uint256 i = 0; i < nameLength; i++) {
            bytes1 character = bytes(config.name)[i];
            if (character < 0x20 || character == 0x22 || character == 0x5c) revert InvalidName();
        }

        uint256 symbolLength = bytes(config.symbol).length;
        if (symbolLength == 0 || symbolLength > 12) revert InvalidSymbol();

        if (config.creator == address(0)) revert ZeroAddress();
        // Native ETH is the canonical default quote asset. Every ERC-20 quote
        // asset must still be explicitly enabled in the immutable registry.
        if (!quoteAssetRegistry.isSupported(config.quoteAsset)) {
            revert UnsupportedQuoteAsset();
        }
        (uint256 phantomQuote, uint256 graduationThreshold) =
            quoteAssetRegistry.economicsOf(config.quoteAsset);
        if (
            phantomQuote == 0 || graduationThreshold == 0
                || config.graduationTarget != graduationThreshold
                || graduationThreshold > MAX_GRADUATION_TARGET
        ) {
            revert InvalidGraduationTarget();
        }
        if (phantomQuote >= MAX_GRADUATION_TARGET || graduationThreshold > MAX_GRADUATION_TARGET - phantomQuote) {
            revert InvalidGraduationTarget();
        }
        if (config.nftMaxSupply < MIN_NFT_SUPPLY || config.nftMaxSupply > MAX_NFT_SUPPLY) {
            revert InvalidNftSupply();
        }
        _validateMintConfig(config.mintConfig, config.nftMaxSupply);
        if (config.tokenHolderBps == 0 || config.nftHolderBps == 0) revert EmptyParticipantAllocation();
        if (config.creatorBps > MAX_CREATOR_BPS) revert CreatorAllocationTooHigh();

        uint256 totalAllocation =
            uint256(config.tokenHolderBps) + uint256(config.nftHolderBps) + uint256(config.creatorBps);
        if (totalAllocation != StockWorldConstants.BPS_DENOMINATOR) revert InvalidFeeAllocation();

        StockWorldTypes.VisualSeed calldata seed = config.visualSeed;
        if (
            seed.imageHash == bytes32(0) || seed.vectorHash == bytes32(0) || seed.paletteHash == bytes32(0)
                || seed.styleHash == bytes32(0)
        ) revert InvalidVisualSeed();
        if (seed.renderMode != 1) revert UnsupportedRenderMode();
        bytes calldata imageURI = bytes(seed.imageURI);
        if (imageURI.length < 8 || imageURI.length > 200) revert InvalidImageURI();
        for (uint256 i = 0; i < imageURI.length; i++) {
            bytes1 character = imageURI[i];
            if (character < 0x20 || character == 0x22 || character == 0x5c) revert InvalidImageURI();
        }
    }

    function _validateMintConfig(StockWorldTypes.MintConfig calldata mintConfig, uint32 nftMaxSupply)
        private
        pure
    {
        if (mintConfig.difficulty > StockWorldConstants.MINT_DIFFICULTY_CUSTOM) {
            revert InvalidMintDifficulty();
        }

        StockWorldTypes.MintSchedule calldata schedule = mintConfig.customSchedule;
        if (mintConfig.difficulty != StockWorldConstants.MINT_DIFFICULTY_CUSTOM) {
            if (
                schedule.commitBlocks != 0 || schedule.revealBlocks != 0 || schedule.claimBlocks != 0
                    || schedule.epochCapacity != 0 || schedule.walletLimit != 0
            ) revert InvalidMintSchedule();
            return;
        }

        if (
            schedule.commitBlocks < StockWorldConstants.MIN_CUSTOM_PHASE_BLOCKS
                || schedule.commitBlocks > StockWorldConstants.MAX_CUSTOM_PHASE_BLOCKS
                || schedule.revealBlocks < StockWorldConstants.MIN_CUSTOM_PHASE_BLOCKS
                || schedule.revealBlocks > StockWorldConstants.MAX_CUSTOM_PHASE_BLOCKS
                || schedule.claimBlocks < StockWorldConstants.MIN_CUSTOM_CLAIM_BLOCKS
                || schedule.claimBlocks > StockWorldConstants.MAX_CUSTOM_PHASE_BLOCKS
                || schedule.epochCapacity == 0 || schedule.epochCapacity > nftMaxSupply
                || schedule.walletLimit == 0
                || schedule.walletLimit > StockWorldConstants.MAX_CUSTOM_WALLET_LIMIT
                || schedule.walletLimit > nftMaxSupply
        ) revert InvalidMintSchedule();
    }

    function _hash(StockWorldTypes.WorldConfig calldata config) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                config.name,
                config.symbol,
                config.quoteAsset,
                config.creator,
                config.graduationTarget,
                config.nftMaxSupply,
                config.tokenHolderBps,
                config.nftHolderBps,
                config.creatorBps,
                config.mintConfig.difficulty,
                config.mintConfig.customSchedule.commitBlocks,
                config.mintConfig.customSchedule.revealBlocks,
                config.mintConfig.customSchedule.claimBlocks,
                config.mintConfig.customSchedule.epochCapacity,
                config.mintConfig.customSchedule.walletLimit,
                config.visualSeed.imageHash,
                config.visualSeed.vectorHash,
                config.visualSeed.paletteHash,
                config.visualSeed.styleHash,
                config.visualSeed.imageURI,
                config.visualSeed.renderMode
            )
        );
    }
}
