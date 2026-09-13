// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldCoreDeployer} from "./StockWorldCoreDeployer.sol";
import {StockWorldGraduationEscrow} from "./StockWorldGraduationEscrow.sol";
import {StockWorldNftDeployer} from "./StockWorldNftDeployer.sol";
import {StockWorldTypes} from "./StockWorldTypes.sol";
import {IWorldRewardReserve} from "./StockWorldGraduationEscrow.sol";
import {IERC20Minimal} from "./libraries/SafeERC20.sol";

/**
 * @title StockWorldLaunchDeployer
 * @notice Creates a complete uninitialized World stack for the calling factory.
 * @dev The two stateless shards keep every deployed runtime below EVM size limits.
 */
contract StockWorldLaunchDeployer {
    StockWorldCoreDeployer public immutable coreDeployer;
    StockWorldNftDeployer public immutable nftDeployer;

    error ZeroAddress();
    error NotContract();

    constructor(StockWorldCoreDeployer coreDeployer_, StockWorldNftDeployer nftDeployer_) {
        if (address(coreDeployer_) == address(0) || address(nftDeployer_) == address(0)) revert ZeroAddress();
        if (address(coreDeployer_).code.length == 0 || address(nftDeployer_).code.length == 0) {
            revert NotContract();
        }
        coreDeployer = coreDeployer_;
        nftDeployer = nftDeployer_;
    }

    function deployWorld(
        StockWorldTypes.WorldConfig calldata config,
        StockWorldTypes.MintSchedule calldata schedule,
        address graduationCoordinator,
        uint256 virtualQuoteReserve
    ) external returns (StockWorldTypes.WorldModules memory modules) {
        (
            modules.worldToken,
            modules.tokenRewardVault,
            modules.worldRewardVault,
            modules.bondingCurve
        ) = coreDeployer.deployCore(config, msg.sender, virtualQuoteReserve);

        (modules.worldNft, modules.fairMintController) =
            nftDeployer.deployNft(config, schedule, msg.sender, modules.worldRewardVault);

        modules.graduationEscrow = address(
            new StockWorldGraduationEscrow(
                IERC20Minimal(config.quoteAsset),
                IERC20Minimal(modules.worldToken),
                IWorldRewardReserve(modules.worldRewardVault),
                msg.sender,
                graduationCoordinator
            )
        );
    }
}
