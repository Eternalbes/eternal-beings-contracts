// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStockWorldGraduationCoordinator} from "../IStockWorldGraduationCoordinator.sol";
import {StockWorldGraduationEscrow} from "../StockWorldGraduationEscrow.sol";

contract MockGraduationCoordinator is IStockWorldGraduationCoordinator {
    bool public preflightAllowed = true;
    bool public completionAllowed = true;
    bytes32 public lastMarketId;
    uint256 public lastQuoteAmount;
    uint256 public lastTokenAmount;
    uint256 public lastPoolTokenAmount;

    error PreflightRejected();
    error CompletionRejected();
    error IncorrectReserves();

    function setPreflightAllowed(bool allowed) external {
        preflightAllowed = allowed;
    }

    function setCompletionAllowed(bool allowed) external {
        completionAllowed = allowed;
    }

    function preflight(uint256, address, address, uint256, uint256) external view {
        if (!preflightAllowed) revert PreflightRejected();
    }

    function createPermanentMarket(
        uint256 worldId,
        address worldToken,
        address quoteAsset,
        address graduationEscrow,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 poolTokenAmount
    ) external returns (bytes32 marketId) {
        if (!completionAllowed) revert CompletionRejected();
        (uint256 receivedQuote, uint256 receivedTokens) =
            StockWorldGraduationEscrow(graduationEscrow).releaseReserves();
        if (receivedQuote != quoteAmount || receivedTokens != tokenAmount) revert IncorrectReserves();

        lastQuoteAmount = quoteAmount;
        lastTokenAmount = tokenAmount;
        lastPoolTokenAmount = poolTokenAmount;
        marketId = keccak256(abi.encode(msg.sender, worldId, worldToken, quoteAsset));
        lastMarketId = marketId;
    }
}
