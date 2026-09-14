// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

interface IStockWorldLockerFactory {
    function graduationCoordinator() external view returns (address);
    function isCanonicalWorld(uint256 worldId, address worldToken) external view returns (bool);
}

interface IPositionOwner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title StockWorldLiquidityLocker
 * @notice Permanently holds V4 positions and excess graduation tokens.
 * @dev There is no owner, withdrawal, rescue, approval, arbitrary-call, or
 *      unlock path. Registration is accepted only from the coordinator fixed
 *      in the calling canonical factory.
 */
contract StockWorldLiquidityLocker {
    using SafeERC20 for IERC20Minimal;

    struct LockedPosition {
        address worldToken;
        uint256 positionId;
        uint256 lockedTokenSupply;
        bool positionLocked;
    }

    address public immutable positionManager;
    mapping(bytes32 worldKey => LockedPosition position) private positions;

    error ZeroAddress();
    error NotContract();
    error NotCanonicalCoordinator();
    error PositionAlreadyLocked();
    error PositionNotHeld();
    error InvalidTokenAmount();
    error UnsupportedTokenBehavior();
    error NotPositionManager();

    event PositionLocked(address indexed factory, uint256 indexed worldId, address indexed worldToken, uint256 positionId);
    event TokenSupplyLocked(address indexed factory, uint256 indexed worldId, address indexed worldToken, uint256 amount);

    constructor(address positionManager_) {
        if (positionManager_ == address(0)) revert ZeroAddress();
        if (positionManager_.code.length == 0) revert NotContract();
        positionManager = positionManager_;
    }

    function lockPosition(address factory, uint256 worldId, address worldToken, uint256 positionId) external {
        _assertCoordinator(factory, worldId, worldToken);
        bytes32 key = worldKey(factory, worldId);
        LockedPosition storage position = positions[key];
        if (position.positionLocked) revert PositionAlreadyLocked();
        if (IPositionOwner(positionManager).ownerOf(positionId) != address(this)) revert PositionNotHeld();

        position.worldToken = worldToken;
        position.positionId = positionId;
        position.positionLocked = true;
        emit PositionLocked(factory, worldId, worldToken, positionId);
    }

    function lockTokenSupply(address factory, uint256 worldId, address worldToken, uint256 amount) external {
        _assertCoordinator(factory, worldId, worldToken);
        if (amount == 0) revert InvalidTokenAmount();

        IERC20Minimal token = IERC20Minimal(worldToken);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnsupportedTokenBehavior();
        }

        positions[worldKey(factory, worldId)].lockedTokenSupply += amount;
        emit TokenSupplyLocked(factory, worldId, worldToken, amount);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != positionManager) revert NotPositionManager();
        return this.onERC721Received.selector;
    }

    function getLockedPosition(address factory, uint256 worldId) external view returns (LockedPosition memory) {
        return positions[worldKey(factory, worldId)];
    }

    function worldKey(address factory, uint256 worldId) public pure returns (bytes32) {
        return keccak256(abi.encode(factory, worldId));
    }

    function _assertCoordinator(address factory, uint256 worldId, address worldToken) private view {
        if (factory == address(0) || factory.code.length == 0 || worldToken == address(0)) revert ZeroAddress();
        IStockWorldLockerFactory canonicalFactory = IStockWorldLockerFactory(factory);
        if (
            canonicalFactory.graduationCoordinator() != msg.sender
                || !canonicalFactory.isCanonicalWorld(worldId, worldToken)
        ) revert NotCanonicalCoordinator();
    }
}
