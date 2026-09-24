// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IStockWorldPermit2,
    IStockWorldV4PositionManager,
    StockWorldV4PoolKey
} from "./interfaces/StockWorldV4Interfaces.sol";
import {IERC20Minimal, SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title StockWorldGraduationExecutor
 * @notice Isolates Permit2 approvals and Uniswap v4 position action encoding.
 * @dev It only accepts calls from its immutable coordinator and returns this
 *      graduation's rounding residuals before the call completes.
 */
contract StockWorldGraduationExecutor {
    using SafeERC20 for IERC20Minimal;

    uint256 private constant MINT_DEADLINE_WINDOW = 300;
    bytes2 private constant MINT_AND_SETTLE_PAIR = 0x020d;

    struct MintRequest {
        StockWorldV4PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        address recipient;
    }

    IStockWorldV4PositionManager public immutable positionManager;
    IStockWorldPermit2 public immutable permit2;
    address public immutable coordinator;

    error NotCoordinator();
    error ZeroAddress();
    error InvalidMintRequest();
    error UnsupportedTokenBehavior();

    constructor(
        IStockWorldV4PositionManager positionManager_,
        IStockWorldPermit2 permit2_,
        address coordinator_
    ) {
        if (address(positionManager_) == address(0) || address(permit2_) == address(0) || coordinator_ == address(0)) {
            revert ZeroAddress();
        }
        positionManager = positionManager_;
        permit2 = permit2_;
        coordinator = coordinator_;
    }

    function mintFullRangePosition(MintRequest calldata request)
        external
        payable
        returns (uint256 residual0, uint256 residual1)
    {
        if (msg.sender != coordinator) revert NotCoordinator();
        if (
            request.key.currency1 == address(0) || request.key.currency0 >= request.key.currency1
                || request.recipient == address(0)
                || request.liquidity == 0 || request.amount0Max == 0 || request.amount1Max == 0
        ) revert InvalidMintRequest();

        IERC20Minimal token1 = IERC20Minimal(request.key.currency1);
        bool native0 = request.key.currency0 == address(0);
        if (native0 ? msg.value != request.amount0Max : msg.value != 0) revert InvalidMintRequest();

        IERC20Minimal token0 = IERC20Minimal(request.key.currency0);
        uint256 baseline0 = native0 ? address(this).balance - msg.value : _pullExact(token0, request.amount0Max);
        uint256 baseline1 = _pullExact(token1, request.amount1Max);
        uint48 expiration = uint48(block.timestamp + MINT_DEADLINE_WINDOW);

        if (!native0) _approvePositionManager(token0, request.amount0Max, expiration);
        _approvePositionManager(token1, request.amount1Max, expiration);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            request.key,
            request.tickLower,
            request.tickUpper,
            uint256(request.liquidity),
            request.amount0Max,
            request.amount1Max,
            request.recipient,
            bytes("")
        );
        params[1] = abi.encode(request.key.currency0, request.key.currency1);
        positionManager.modifyLiquidities{value: native0 ? request.amount0Max : 0}(
            abi.encode(abi.encodePacked(MINT_AND_SETTLE_PAIR), params), block.timestamp + MINT_DEADLINE_WINDOW
        );

        if (!native0) _revokePositionManager(token0);
        _revokePositionManager(token1);
        residual0 = native0 ? _returnNativeResidual(baseline0) : _returnResidual(token0, baseline0);
        residual1 = _returnResidual(token1, baseline1);
    }

    function _pullExact(IERC20Minimal token, uint256 amount) private returns (uint256 baseline) {
        baseline = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < baseline || afterBalance - baseline != amount) revert UnsupportedTokenBehavior();
    }

    function _approvePositionManager(IERC20Minimal token, uint256 amount, uint48 expiration) private {
        token.forceApprove(address(permit2), amount);
        permit2.approve(address(token), address(positionManager), uint160(amount), expiration);
    }

    function _revokePositionManager(IERC20Minimal token) private {
        permit2.approve(address(token), address(positionManager), 0, 0);
        token.forceApprove(address(permit2), 0);
    }

    function _returnResidual(IERC20Minimal token, uint256 baseline) private returns (uint256 amount) {
        uint256 balance = token.balanceOf(address(this));
        if (balance < baseline) revert UnsupportedTokenBehavior();
        amount = balance - baseline;
        if (amount != 0) token.safeTransfer(coordinator, amount);
    }

    function _returnNativeResidual(uint256 baseline) private returns (uint256 amount) {
        uint256 balance = address(this).balance;
        if (balance < baseline) revert UnsupportedTokenBehavior();
        amount = balance - baseline;
        if (amount != 0) {
            (bool success,) = coordinator.call{value: amount}("");
            if (!success) revert UnsupportedTokenBehavior();
        }
    }

    receive() external payable {}
}
