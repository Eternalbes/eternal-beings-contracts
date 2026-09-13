// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FairMintController, IWorldNftMinter} from "./FairMintController.sol";
import {StockWorldTypes} from "./StockWorldTypes.sol";
import {IWorldNftRewardVault, WorldNFT} from "./WorldNFT.sol";

/**
 * @title StockWorldNftDeployer
 * @notice Stateless NFT bytecode shard used by the canonical LaunchDeployer.
 */
contract StockWorldNftDeployer {
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
            IWorldNftRewardVault(worldRewardVault)
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
