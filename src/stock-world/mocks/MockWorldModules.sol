// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWorldRewardVaultMockTarget {
    function checkpointNftWeight(uint256 tokenId, address beneficiary, uint256 newWeight) external;
    function releaseLiquidityReserve() external returns (uint256);
}

contract MockWorldModules {
    IWorldRewardVaultMockTarget public immutable vault;

    constructor(IWorldRewardVaultMockTarget vault_) {
        vault = vault_;
    }

    function checkpoint(uint256 tokenId, address beneficiary, uint256 newWeight) external {
        vault.checkpointNftWeight(tokenId, beneficiary, newWeight);
    }

    function releaseReserve() external returns (uint256) {
        return vault.releaseLiquidityReserve();
    }
}
