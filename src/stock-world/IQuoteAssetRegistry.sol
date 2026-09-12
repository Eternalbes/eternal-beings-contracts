// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IQuoteAssetRegistry {
    function isSupported(address asset) external view returns (bool);
    function decimalsOf(address asset) external view returns (uint8);
}
