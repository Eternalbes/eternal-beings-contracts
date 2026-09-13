// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library StockWorldTypes {
    struct WorldConfig {
        string name;
        string symbol;
        address quoteAsset;
        address creator;
        uint256 graduationTarget;
        uint32 nftMaxSupply;
        uint16 tokenHolderBps;
        uint16 nftHolderBps;
        uint16 creatorBps;
    }

    struct MintSchedule {
        uint32 commitBlocks;
        uint32 revealBlocks;
        uint32 claimBlocks;
        uint32 epochCapacity;
        uint16 walletLimit;
    }

    struct WorldModules {
        address worldToken;
        address tokenRewardVault;
        address worldRewardVault;
        address bondingCurve;
        address worldNft;
        address fairMintController;
        address graduationEscrow;
    }
}

library StockWorldConstants {
    uint256 internal constant WORLD_TOKEN_SUPPLY = 1_000_000 ether;
    uint256 internal constant PLATFORM_LAUNCH_FEE = 0.0003 ether;

    uint32 internal constant MIN_NFT_SUPPLY = 100;
    uint32 internal constant MAX_NFT_SUPPLY = 10_000;
    uint16 internal constant DEFAULT_NFT_WALLET_LIMIT = 2;
    uint32 internal constant MINT_DISTRIBUTION_EPOCHS = 30;

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant BASE_TRADING_FEE_BPS = 100;
    uint16 internal constant MAX_CREATOR_BPS = 3_000;
}
