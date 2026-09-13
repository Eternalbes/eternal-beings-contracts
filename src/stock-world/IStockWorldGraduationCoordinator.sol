// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStockWorldGraduationCoordinator
 * @notice Immutable boundary between a Stock World launch and its permanent market.
 * @dev A coordinator must pull the exact tracked reserves from the supplied escrow
 *      during createPermanentMarket. Returning without consuming them is rejected
 *      by the factory.
 */
interface IStockWorldGraduationCoordinator {
    function preflight(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external view;

    function createPermanentMarket(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address graduationEscrow,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external returns (bytes32 marketId);
}
