// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldConstants} from "./StockWorldTypes.sol";

/**
 * @title WorldToken
 * @notice Fixed-supply ERC-20 used by one Stock World.
 * @dev There is intentionally no owner, mint, freeze, blacklist, or upgrade path.
 */
contract WorldToken {
    string public name;
    string public symbol;

    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = StockWorldConstants.WORLD_TOKEN_SUPPLY;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    error ZeroAddress();
    error InvalidName();
    error InvalidSymbol();
    error InsufficientBalance();
    error InsufficientAllowance();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, address initialHolder) {
        uint256 nameLength = bytes(name_).length;
        if (nameLength == 0 || nameLength > 64) revert InvalidName();

        uint256 symbolLength = bytes(symbol_).length;
        if (symbolLength == 0 || symbolLength > 12) revert InvalidSymbol();
        if (initialHolder == address(0)) revert ZeroAddress();

        name = name_;
        symbol = symbol_;
        balanceOf[initialHolder] = totalSupply;

        emit Transfer(address(0), initialHolder, totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from == address(0)) revert ZeroAddress();

        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();

        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }

        emit Transfer(from, to, amount);
    }
}
