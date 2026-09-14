// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./FullMath.sol";

/**
 * @title StockWorldGraduationMath
 * @notice Price-preserving reserve conversion for a permanent V4 market.
 * @dev The pool cannot contain the virtual quote reserve. It therefore uses
 *      only the World Token amount that preserves the curve's terminal price;
 *      the remaining World Tokens must be permanently locked.
 */
library StockWorldGraduationMath {
    error InvalidGraduationAmounts();
    error UnsupportedPrice();
    error InvalidTick();

    function poolTokenAmount(
        uint256 totalTokenAmount,
        uint256 curveQuoteAmount,
        uint256 additionalQuoteAmount,
        uint256 virtualQuoteReserve
    ) internal pure returns (uint256 amount) {
        if (totalTokenAmount == 0 || curveQuoteAmount == 0 || virtualQuoteReserve == 0) {
            revert InvalidGraduationAmounts();
        }
        if (
            curveQuoteAmount > type(uint256).max - additionalQuoteAmount
                || curveQuoteAmount > type(uint256).max - virtualQuoteReserve
        ) revert InvalidGraduationAmounts();

        uint256 liquidityQuote = curveQuoteAmount + additionalQuoteAmount;
        uint256 terminalVirtualQuote = curveQuoteAmount + virtualQuoteReserve;
        if (liquidityQuote > terminalVirtualQuote) revert InvalidGraduationAmounts();
        amount = FullMath.mulDiv(totalTokenAmount, liquidityQuote, terminalVirtualQuote);
        if (amount == 0 || amount > totalTokenAmount) revert InvalidGraduationAmounts();
    }

    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert InvalidGraduationAmounts();

        if (_fitsQ192(amount0, amount1)) {
            uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
            uint256 root = _sqrt(ratioX192);
            if (root > type(uint160).max) revert UnsupportedPrice();
            return uint160(root);
        }

        if (!_fitsQ128(amount0, amount1)) revert UnsupportedPrice();
        uint256 ratioX128 = FullMath.mulDiv(amount1, 1 << 128, amount0);
        uint256 sqrtPriceX64 = _sqrt(ratioX128);
        if (sqrtPriceX64 > type(uint128).max) revert UnsupportedPrice();
        return uint160(sqrtPriceX64 << 32);
    }

    /**
     * @dev Equivalent to Uniswap v4 TickMath.getSqrtPriceAtTick (MIT), kept
     *      local so the launch contracts compile without a mutable package dependency.
     */
    function sqrtPriceAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick;
            assembly ("memory-safe") {
                tick := signextend(2, tick)
                let mask := sar(255, tick)
                absTick := xor(mask, add(mask, tick))
            }
            if (absTick > 887272) revert InvalidTick();

            uint256 price;
            assembly ("memory-safe") {
                price := xor(
                    shl(128, 1),
                    mul(xor(shl(128, 1), 0xfffcb933bd6fad37aa2d162d1a594001), and(absTick, 0x1))
                )
            }
            if (absTick & 0x2 != 0) price = (price * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) price = (price * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) price = (price * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) price = (price * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) price = (price * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) price = (price * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) price = (price * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) price = (price * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) price = (price * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) price = (price * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) price = (price * 0x48a170391f7dc42444e8fa2) >> 128;

            assembly ("memory-safe") {
                if sgt(tick, 0) { price := div(not(0), price) }
                sqrtPriceX96 := shr(32, add(price, sub(shl(32, 1), 1)))
            }
        }
    }

    function _fitsQ192(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint192).max) return true;
        return amount1 < (amount0 << 64);
    }

    function _fitsQ128(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint128).max) return true;
        return amount1 < (amount0 << 128);
    }

    function _sqrt(uint256 value) private pure returns (uint256 result) {
        if (value == 0) return 0;
        result = 1 << (_log2(value) >> 1);
        unchecked {
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            result = (result + value / result) >> 1;
            uint256 roundedDown = value / result;
            return result < roundedDown ? result : roundedDown;
        }
    }

    function _log2(uint256 value) private pure returns (uint256 result) {
        if (value >> 128 != 0) { value >>= 128; result += 128; }
        if (value >> 64 != 0) { value >>= 64; result += 64; }
        if (value >> 32 != 0) { value >>= 32; result += 32; }
        if (value >> 16 != 0) { value >>= 16; result += 16; }
        if (value >> 8 != 0) { value >>= 8; result += 8; }
        if (value >> 4 != 0) { value >>= 4; result += 4; }
        if (value >> 2 != 0) { value >>= 2; result += 2; }
        if (value >> 1 != 0) result += 1;
    }
}
