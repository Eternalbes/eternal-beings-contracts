// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./FullMath.sol";

/**
 * @title StockWorldCurveMath
 * @notice Constant-product exact-input and exact-output quotes.
 * @dev Adapted from the MIT-licensed Pons V2 bonding-curve math at commit
 *      e9dfc58128e8534d2e9d4d65be18f1dea32c404f. FullMath is used here to
 *      avoid intermediate multiplication overflow.
 */
library StockWorldCurveMath {
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0 || feeBps >= BPS_DENOMINATOR) {
            revert InsufficientLiquidity();
        }

        uint256 netAmountIn = FullMath.mulDiv(amountIn, BPS_DENOMINATOR - feeBps, BPS_DENOMINATOR);
        amountOut = FullMath.mulDiv(netAmountIn, reserveOut, reserveIn + netAmountIn);
        if (amountOut == 0) revert InsufficientOutputAmount();
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut <= amountOut || feeBps >= BPS_DENOMINATOR) {
            revert InsufficientLiquidity();
        }

        uint256 netAmountIn = FullMath.mulDivRoundingUp(amountOut, reserveIn, reserveOut - amountOut);
        amountIn = FullMath.mulDivRoundingUp(netAmountIn, BPS_DENOMINATOR, BPS_DENOMINATOR - feeBps);
    }
}
