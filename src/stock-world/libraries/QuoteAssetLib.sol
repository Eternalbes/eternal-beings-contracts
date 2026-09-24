// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal, SafeERC20} from "./SafeERC20.sol";

/**
 * @title QuoteAssetLib
 * @notice Shared native-ETH and ERC-20 quote-asset accounting primitives.
 * @dev The zero address represents native ETH. Every inbound amount is checked
 *      exactly so fee-on-transfer ERC-20s and accidental msg.value are rejected.
 */
library QuoteAssetLib {
    using SafeERC20 for IERC20Minimal;

    error IncorrectNativeValue();
    error NativeTransferFailed();
    error UnsupportedTokenBehavior();

    function balanceOf(address asset, address account) internal view returns (uint256) {
        return asset == address(0) ? account.balance : IERC20Minimal(asset).balanceOf(account);
    }

    function pullExact(address asset, address from, uint256 amount) internal {
        if (asset == address(0)) {
            if (msg.value != amount || from != msg.sender) revert IncorrectNativeValue();
            return;
        }
        if (msg.value != 0) revert IncorrectNativeValue();

        IERC20Minimal token = IERC20Minimal(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
    }

    function send(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            (bool success,) = to.call{value: amount}("");
            if (!success) revert NativeTransferFailed();
        } else {
            IERC20Minimal(asset).safeTransfer(to, amount);
        }
    }
}
