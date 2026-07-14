// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestCryptoPunks {
    mapping(uint256 => address) public punkIndexToAddress;
    mapping(address => uint256) public balanceOf;

    event Assign(address indexed to, uint256 indexed punkIndex);
    event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex);

    function mint(address to, uint256 punkIndex) external {
        require(to != address(0), "zero to");
        require(punkIndexToAddress[punkIndex] == address(0), "exists");
        punkIndexToAddress[punkIndex] = to;
        balanceOf[to] += 1;
        emit Assign(to, punkIndex);
    }

    function transferPunk(address to, uint256 punkIndex) external {
        require(to != address(0), "zero to");
        address owner = punkIndexToAddress[punkIndex];
        require(owner == msg.sender, "not owner");
        punkIndexToAddress[punkIndex] = to;
        balanceOf[owner] -= 1;
        balanceOf[to] += 1;
        emit PunkTransfer(owner, to, punkIndex);
    }
}
