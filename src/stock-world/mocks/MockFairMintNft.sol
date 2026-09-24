// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockFairMintNft {
    uint32 public immutable maxSupply;
    uint256 public totalMinted;

    constructor(uint32 maxSupply_) {
        maxSupply = maxSupply_;
    }

    function mintFromController(address, bytes32) external returns (uint256 tokenId) {
        tokenId = ++totalMinted;
    }
}
