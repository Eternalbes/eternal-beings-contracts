// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev ArbOS history uses L2 block numbers and a 393,168-slot ring buffer.
 *      Pin its runtime: the Ethereum EIP-2935 runtime has a different clock
 *      and window, so merely finding code at the same address is insufficient.
 */
library StockWorldBlockHistory {
    address internal constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint32 internal constant HISTORY_WINDOW = 393_168;
    bytes32 internal constant HISTORY_CODE_HASH =
        0xceef1f6ad6c0cb7eb8fb15678abf11da3ce0d3a7c7106aa900c5930e556a43ff;

    function available() internal view returns (bool) {
        return HISTORY_STORAGE.codehash == HISTORY_CODE_HASH;
    }

    function blockHash(uint256 blockNumber) internal view returns (bytes32) {
        if (!available()) return bytes32(0);
        (bool success, bytes memory result) = HISTORY_STORAGE.staticcall{gas: 30_000}(
            abi.encode(blockNumber)
        );
        if (!success || result.length != 32) return bytes32(0);
        return abi.decode(result, (bytes32));
    }
}
