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
    uint16 public constant DEFAULT_NFT_WALLET_LIMIT = StockWorldConstants.DEFAULT_NFT_WALLET_LIMIT;
    uint16 public constant BASE_TRADING_FEE_BPS = StockWorldConstants.BASE_TRADING_FEE_BPS;
    uint16 public constant MAX_CREATOR_BPS = StockWorldConstants.MAX_CREATOR_BPS;

    error ZeroAddress();
    error InvalidName();
    error InvalidSymbol();
    error UnsupportedQuoteAsset();
    error InvalidGraduationTarget();
    error InvalidNftSupply();
    error EmptyParticipantAllocation();
    error CreatorAllocationTooHigh();
    error InvalidFeeAllocation();

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

        uint256 symbolLength = bytes(config.symbol).length;
        if (symbolLength == 0 || symbolLength > 12) revert InvalidSymbol();

        if (config.creator == address(0)) revert ZeroAddress();
        // Native ETH is the canonical default quote asset. Every ERC-20 quote
        // asset must still be explicitly enabled in the immutable registry.
        if (config.quoteAsset != address(0) && !quoteAssetRegistry.isSupported(config.quoteAsset)) {
            revert UnsupportedQuoteAsset();
        }
        if (config.graduationTarget == 0) revert InvalidGraduationTarget();
        uint256 virtualQuoteReserve = config.graduationTarget / 9 + (config.graduationTarget % 9 == 0 ? 0 : 1);
        if (config.graduationTarget > type(uint256).max - virtualQuoteReserve) {
            revert InvalidGraduationTarget();
        }
        if (config.nftMaxSupply < MIN_NFT_SUPPLY || config.nftMaxSupply > MAX_NFT_SUPPLY) {
            revert InvalidNftSupply();
        }
        if (config.tokenHolderBps == 0 || config.nftHolderBps == 0) revert EmptyParticipantAllocation();
        if (config.creatorBps > MAX_CREATOR_BPS) revert CreatorAllocationTooHigh();

        uint256 totalAllocation =
            uint256(config.tokenHolderBps) + uint256(config.nftHolderBps) + uint256(config.creatorBps);
        if (totalAllocation != StockWorldConstants.BPS_DENOMINATOR) revert InvalidFeeAllocation();
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
                config.creatorBps
            )
        );
    }
}
