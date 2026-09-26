// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteAssetRegistry} from "./IQuoteAssetRegistry.sol";
import {StockWorldConstants} from "./StockWorldTypes.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * @title QuoteAssetRegistry
 * @notice Records quote assets that future Stock Worlds may select at launch.
 * @dev Registry changes never modify the configuration of an existing World.
 *      The immutable authority should be a disclosed timelock or multisig.
 */
contract QuoteAssetRegistry is IQuoteAssetRegistry {
    struct QuoteAsset {
        uint8 decimals;
        bool registered;
        bool enabled;
        uint256 phantomQuote;
        uint256 graduationThreshold;
    }

    uint256 public constant NATIVE_PHANTOM_QUOTE = 1.68 ether;
    uint256 public constant NATIVE_GRADUATION_THRESHOLD = 4.2 ether;

    address public immutable authority;

    mapping(address asset => QuoteAsset info) private quoteAssets;

    error Unauthorized();
    error ZeroAddress();
    error NotContract();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidDecimals();
    error InvalidEconomics();

    event QuoteAssetRegistered(
        address indexed asset,
        uint8 decimals,
        uint256 phantomQuote,
        uint256 graduationThreshold
    );
    event QuoteAssetStatusChanged(address indexed asset, bool enabled);
    event QuoteAssetEconomicsChanged(
        address indexed asset, uint256 phantomQuote, uint256 graduationThreshold
    );

    constructor(address authority_) {
        if (authority_ == address(0)) revert ZeroAddress();
        authority = authority_;
        quoteAssets[address(0)] = QuoteAsset({
            decimals: 18,
            registered: true,
            enabled: true,
            phantomQuote: NATIVE_PHANTOM_QUOTE,
            graduationThreshold: NATIVE_GRADUATION_THRESHOLD
        });
        emit QuoteAssetRegistered(
            address(0), 18, NATIVE_PHANTOM_QUOTE, NATIVE_GRADUATION_THRESHOLD
        );
        emit QuoteAssetStatusChanged(address(0), true);
    }

    modifier onlyAuthority() {
        if (msg.sender != authority) revert Unauthorized();
        _;
    }

    function registerQuoteAsset(
        address asset,
        uint256 phantomQuote,
        uint256 graduationThreshold
    ) external onlyAuthority {
        if (asset == address(0)) revert ZeroAddress();
        if (asset.code.length == 0) revert NotContract();
        if (quoteAssets[asset].registered) revert AlreadyRegistered();
        _validateEconomics(phantomQuote, graduationThreshold);

        (bool success, bytes memory result) = asset.staticcall(abi.encodeCall(IERC20Decimals.decimals, ()));
        if (!success || result.length < 32) revert InvalidDecimals();

        uint256 reportedDecimals = abi.decode(result, (uint256));
        if (reportedDecimals > 36) revert InvalidDecimals();

        uint8 assetDecimals = uint8(reportedDecimals);
        quoteAssets[asset] = QuoteAsset({
            decimals: assetDecimals,
            registered: true,
            enabled: true,
            phantomQuote: phantomQuote,
            graduationThreshold: graduationThreshold
        });

        emit QuoteAssetRegistered(asset, assetDecimals, phantomQuote, graduationThreshold);
        emit QuoteAssetStatusChanged(asset, true);
    }

    function setQuoteAssetEconomics(
        address asset,
        uint256 phantomQuote,
        uint256 graduationThreshold
    ) external onlyAuthority {
        QuoteAsset storage info = quoteAssets[asset];
        if (!info.registered) revert NotRegistered();
        _validateEconomics(phantomQuote, graduationThreshold);

        info.phantomQuote = phantomQuote;
        info.graduationThreshold = graduationThreshold;
        emit QuoteAssetEconomicsChanged(asset, phantomQuote, graduationThreshold);
    }

    function setQuoteAssetEnabled(address asset, bool enabled) external onlyAuthority {
        QuoteAsset storage info = quoteAssets[asset];
        if (!info.registered) revert NotRegistered();
        if (info.enabled == enabled) return;

        info.enabled = enabled;
        emit QuoteAssetStatusChanged(asset, enabled);
    }

    function isSupported(address asset) external view returns (bool) {
        return quoteAssets[asset].enabled;
    }

    function decimalsOf(address asset) external view returns (uint8) {
        QuoteAsset memory info = quoteAssets[asset];
        if (!info.registered) revert NotRegistered();
        return info.decimals;
    }

    function economicsOf(address asset)
        external
        view
        returns (uint256 phantomQuote, uint256 graduationThreshold)
    {
        QuoteAsset memory info = quoteAssets[asset];
        if (!info.registered) revert NotRegistered();
        return (info.phantomQuote, info.graduationThreshold);
    }

    function getQuoteAsset(address asset) external view returns (QuoteAsset memory) {
        return quoteAssets[asset];
    }

    function _validateEconomics(uint256 phantomQuote, uint256 graduationThreshold) private pure {
        uint256 maxSeed = StockWorldConstants.MAX_GRADUATION_SEED_AMOUNT;
        uint256 scaledPhantom = phantomQuote * 5;
        uint256 scaledThreshold = graduationThreshold * 2;
        uint256 ratioRounding = scaledPhantom > scaledThreshold
            ? scaledPhantom - scaledThreshold
            : scaledThreshold - scaledPhantom;
        if (
            phantomQuote == 0 || graduationThreshold == 0 || phantomQuote >= maxSeed
                || graduationThreshold > maxSeed - phantomQuote
                || ratioRounding > 5
        ) revert InvalidEconomics();
    }
}
