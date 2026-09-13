// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldTypes} from "./StockWorldTypes.sol";
import {
    IWorldRewardVaultFeeSink,
    StockWorldBondingCurve
} from "./StockWorldBondingCurve.sol";
import {TokenRewardVault} from "./TokenRewardVault.sol";
import {ITokenRewardVault, WorldRewardVault} from "./WorldRewardVault.sol";
import {WorldToken} from "./WorldToken.sol";
import {IERC20Minimal} from "./libraries/SafeERC20.sol";

/**
 * @title StockWorldCoreDeployer
 * @notice Stateless bytecode shard used by the canonical LaunchDeployer.
 */
contract StockWorldCoreDeployer {
    function deployCore(
        StockWorldTypes.WorldConfig calldata config,
        address factory,
        uint256 virtualQuoteReserve
    )
        external
        returns (
            address worldToken,
            address tokenRewardVault,
            address worldRewardVault,
            address bondingCurve
        )
    {
        WorldToken token = new WorldToken(config.name, config.symbol, factory);
        TokenRewardVault tokenVault = new TokenRewardVault(
            IERC20Minimal(address(token)), IERC20Minimal(config.quoteAsset)
        );
        WorldRewardVault rewardVault = new WorldRewardVault(
            IERC20Minimal(config.quoteAsset),
            ITokenRewardVault(address(tokenVault)),
            factory,
            config.creator,
            config.tokenHolderBps,
            config.nftHolderBps,
            config.creatorBps
        );
        StockWorldBondingCurve curve = new StockWorldBondingCurve(
            IERC20Minimal(config.quoteAsset),
            IWorldRewardVaultFeeSink(address(rewardVault)),
            factory,
            virtualQuoteReserve,
            config.graduationTarget
        );

        return (address(token), address(tokenVault), address(rewardVault), address(curve));
    }
}
