// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./libraries/FullMath.sol";
import {StockWorldGraduationMath} from "./libraries/StockWorldGraduationMath.sol";
import {StockWorldConstants} from "./StockWorldTypes.sol";

/**
 * @title StockWorldGraduationGuard
 * @notice Stateless rejection boundary for a full-range Uniswap v4 seed.
 */
contract StockWorldGraduationGuard {
    uint160 public constant MIN_SQRT_PRICE = 4_295_128_739;
    uint160 public constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    uint256 public constant MAX_SEED_AMOUNT = StockWorldConstants.MAX_GRADUATION_SEED_AMOUNT;
    uint256 private constant Q96 = 1 << 96;

    error InvalidCurrencyPair();
    error InvalidTickSpacing();
    error GraduationSeedNotViable();
    error SqrtPriceOutOfBounds();

    function assertSeedable(
        address worldToken,
        address quoteAsset,
        int24 tickSpacing,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external pure returns (uint160 sqrtPriceX96, uint128 liquidity) {
        if (worldToken == address(0) || worldToken == quoteAsset) {
            revert InvalidCurrencyPair();
        }
        if (tickSpacing < 1 || tickSpacing > type(int16).max) revert InvalidTickSpacing();
        if (
            quoteAmount == 0 || tokenAmount == 0 || quoteAmount > MAX_SEED_AMOUNT
                || tokenAmount > MAX_SEED_AMOUNT
        ) revert GraduationSeedNotViable();

        (uint256 amount0, uint256 amount1) =
            quoteAsset < worldToken ? (quoteAmount, tokenAmount) : (tokenAmount, quoteAmount);
        sqrtPriceX96 = StockWorldGraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        if (sqrtPriceX96 <= MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
            revert SqrtPriceOutOfBounds();
        }

        int24 tickLower = (-887272 / tickSpacing) * tickSpacing;
        int24 tickUpper = (887272 / tickSpacing) * tickSpacing;
        uint160 sqrtLowerX96 = StockWorldGraduationMath.sqrtPriceAtTick(tickLower);
        uint160 sqrtUpperX96 = StockWorldGraduationMath.sqrtPriceAtTick(tickUpper);
        uint256 intermediate = FullMath.mulDiv(sqrtPriceX96, sqrtUpperX96, Q96);
        uint256 liquidity0 = FullMath.mulDiv(amount0, intermediate, sqrtUpperX96 - sqrtPriceX96);
        uint256 liquidity1 = FullMath.mulDiv(amount1, Q96, sqrtPriceX96 - sqrtLowerX96);
        uint256 computed = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        uint256 maxPerTick = _maxLiquidityPerTick(tickSpacing);
        if (computed == 0 || computed > maxPerTick || computed > type(uint128).max) {
            revert GraduationSeedNotViable();
        }
        liquidity = uint128(computed);
    }

    function _maxLiquidityPerTick(int24 tickSpacing) private pure returns (uint256) {
        int256 spacing = int256(tickSpacing);
        int256 minTick = int256(-887272) / spacing;
        if (int256(-887272) % spacing != 0) minTick -= 1;
        int256 maxTick = int256(887272) / spacing;
        uint256 numberOfTicks = uint256(maxTick - minTick + 1);
        return type(uint128).max / numberOfTicks;
    }
}
