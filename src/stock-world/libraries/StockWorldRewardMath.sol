// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./FullMath.sol";

library StockWorldRewardMath {
    uint256 internal constant SCALE = 1e27;

    // Carry only fractions earned by this beneficiary, never fractions from
    // the global index before the beneficiary joined or changed weight.
    function accrue(uint256 weight, uint256 indexDelta, uint256 remainder)
        internal pure returns (uint256 amount, uint256 nextRemainder)
    {
        amount = FullMath.mulDiv(weight, indexDelta, SCALE);
        uint256 fraction = mulmod(weight, indexDelta, SCALE) + remainder;
        amount += fraction / SCALE;
        nextRemainder = fraction % SCALE;
    }
}
