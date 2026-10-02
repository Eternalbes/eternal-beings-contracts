// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockArbSysBlockClock {
    uint256 public arbBlockNumber;
    mapping(uint256 => bytes32) private hashes;

    function setBlockNumber(uint256 number) external {
        arbBlockNumber = number;
    }

    function setBlockHash(uint256 number, bytes32 hash) external {
        hashes[number] = hash;
    }

    function arbBlockHash(uint256 number) external view returns (bytes32) {
        require(number < arbBlockNumber && arbBlockNumber - number <= 256, "unavailable block");
        return hashes[number];
    }
}

contract MockArbSysNativeClock {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 number) external view returns (bytes32) {
        require(number < block.number && block.number - number <= 256, "unavailable block");
        return blockhash(number);
    }
}
