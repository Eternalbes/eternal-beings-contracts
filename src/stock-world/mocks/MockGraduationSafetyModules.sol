// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldGraduationMath} from "../libraries/StockWorldGraduationMath.sol";

interface IReceiverTarget {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract MockPositionManager {
    mapping(uint256 tokenId => address owner) public ownerOf;

    function mint(address to, uint256 tokenId) external {
        require(to != address(0) && ownerOf[tokenId] == address(0), "invalid mint");
        ownerOf[tokenId] = to;
    }

    function callReceiver(address receiver, uint256 tokenId) external returns (bytes4) {
        return IReceiverTarget(receiver).onERC721Received(msg.sender, address(0), tokenId, "");
    }
}

contract MockLockerFactory {
    address public immutable graduationCoordinator;
    mapping(uint256 worldId => address worldToken) public canonicalToken;

    constructor(address graduationCoordinator_) {
        graduationCoordinator = graduationCoordinator_;
    }

    function setCanonicalWorld(uint256 worldId, address worldToken) external {
        canonicalToken[worldId] = worldToken;
    }

    function isCanonicalWorld(uint256 worldId, address worldToken) external view returns (bool) {
        return canonicalToken[worldId] == worldToken;
    }
}

contract MockGraduationMathHarness {
    function sqrtPriceAtTick(int24 tick) external pure returns (uint160) {
        return StockWorldGraduationMath.sqrtPriceAtTick(tick);
    }

    function poolTokenAmount(
        uint256 totalTokenAmount,
        uint256 curveQuoteAmount,
        uint256 additionalQuoteAmount,
        uint256 virtualQuoteReserve
    ) external pure returns (uint256) {
        return StockWorldGraduationMath.poolTokenAmount(
            totalTokenAmount, curveQuoteAmount, additionalQuoteAmount, virtualQuoteReserve
        );
    }
}
