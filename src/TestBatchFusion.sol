// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBatchFusionGame {
    function fuseBeing(uint256 parentId, uint256 sacrificeId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract TestBatchFusion {
    function batchFuse(address game, uint256 parentId, uint256[] calldata sacrificeIds) external {
        for (uint256 i = 0; i < sacrificeIds.length; i++) {
            IBatchFusionGame(game).fuseBeing(parentId, sacrificeIds[i]);
        }
    }

    function withdraw(address game, uint256 tokenId, address to) external {
        IBatchFusionGame(game).transferFrom(address(this), to, tokenId);
    }
}
