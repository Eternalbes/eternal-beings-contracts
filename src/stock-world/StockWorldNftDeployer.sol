// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FairMintController, IWorldNftMinter} from "./FairMintController.sol";
import {StockWorldTypes} from "./StockWorldTypes.sol";
import {IWorldNftRewardVault, WorldNFT} from "./WorldNFT.sol";
import {StockWorldRenderer} from "./StockWorldRenderer.sol";

/**
 * @title StockWorldNftDeployer
 * @notice Stateless NFT bytecode shard used by the canonical LaunchDeployer.
 */
contract StockWorldNftDeployer {
    StockWorldRenderer public immutable renderer;

    error ZeroAddress();
    error NotContract();

    constructor(StockWorldRenderer renderer_) {
        if (address(renderer_) == address(0)) revert ZeroAddress();
        if (address(renderer_).code.length == 0) revert NotContract();
        renderer = renderer_;
    }

    function deployNft(
        StockWorldTypes.WorldConfig calldata config,
        StockWorldTypes.MintSchedule calldata schedule,
        address factory,
        address worldRewardVault
    ) external returns (address worldNft, address fairMintController) {
        WorldNFT nft = new WorldNFT(
            string.concat(config.name, " Beings"),
            string.concat(config.symbol, "-NFT"),
            config.nftMaxSupply,
            factory,
            IWorldNftRewardVault(worldRewardVault),
            renderer,
            config.visualSeed
        );
        FairMintController controller = new FairMintController(
            IWorldNftMinter(address(nft)),
            config.nftMaxSupply,
            schedule.commitBlocks,
            schedule.revealBlocks,
            schedule.claimBlocks,
            schedule.epochCapacity,
            schedule.walletLimit
        );

        return (address(nft), address(controller));
    }
}
