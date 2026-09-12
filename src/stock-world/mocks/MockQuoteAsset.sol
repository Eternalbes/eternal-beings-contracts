// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Test helper only. It is not a production quote asset implementation.
 */
contract MockQuoteAsset {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    mapping(address account => uint256 balance) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
