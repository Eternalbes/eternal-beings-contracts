// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteAssetRegistry} from "./IQuoteAssetRegistry.sol";

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
    }

    address public immutable authority;

    mapping(address asset => QuoteAsset info) private quoteAssets;

    error Unauthorized();
    error ZeroAddress();
    error NotContract();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidDecimals();

    event QuoteAssetRegistered(address indexed asset, uint8 decimals);
    event QuoteAssetStatusChanged(address indexed asset, bool enabled);

    constructor(address authority_) {
        if (authority_ == address(0)) revert ZeroAddress();
        authority = authority_;
    }

    modifier onlyAuthority() {
        if (msg.sender != authority) revert Unauthorized();
        _;
    }

    function registerQuoteAsset(address asset) external onlyAuthority {
        if (asset == address(0)) revert ZeroAddress();
        if (asset.code.length == 0) revert NotContract();
        if (quoteAssets[asset].registered) revert AlreadyRegistered();

        (bool success, bytes memory result) = asset.staticcall(abi.encodeCall(IERC20Decimals.decimals, ()));
        if (!success || result.length < 32) revert InvalidDecimals();

        uint256 reportedDecimals = abi.decode(result, (uint256));
        if (reportedDecimals > 36) revert InvalidDecimals();

        uint8 assetDecimals = uint8(reportedDecimals);
        quoteAssets[asset] = QuoteAsset({decimals: assetDecimals, registered: true, enabled: true});

        emit QuoteAssetRegistered(asset, assetDecimals);
        emit QuoteAssetStatusChanged(asset, true);
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

    function getQuoteAsset(address asset) external view returns (QuoteAsset memory) {
        return quoteAssets[asset];
    }
}
