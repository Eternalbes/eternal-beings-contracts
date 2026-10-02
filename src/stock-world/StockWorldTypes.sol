// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library StockWorldTypes {
    struct MintSchedule {
        uint32 commitBlocks;
        uint32 revealBlocks;
        uint32 claimBlocks;
        uint32 epochCapacity;
        uint16 walletLimit;
    }

    struct MintConfig {
        uint8 difficulty;
        MintSchedule customSchedule;
    }

    struct VisualSeed {
        bytes32 imageHash;
        bytes32 vectorHash;
        bytes32 paletteHash;
        bytes32 styleHash;
        string imageURI;
        uint8 renderMode;
    }

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
        MintConfig mintConfig;
        VisualSeed visualSeed;
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
    uint256 internal constant WORLD_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 internal constant PLATFORM_LAUNCH_FEE = 0.0003 ether;

    uint32 internal constant MIN_NFT_SUPPLY = 100;
    uint32 internal constant MAX_NFT_SUPPLY = 10_000;

    uint8 internal constant MINT_DIFFICULTY_EASY = 0;
    uint8 internal constant MINT_DIFFICULTY_HARD = 1;
    uint8 internal constant MINT_DIFFICULTY_HELL = 2;
    uint8 internal constant MINT_DIFFICULTY_CUSTOM = 3;

    uint32 internal constant EASY_COMMIT_BLOCKS = 158_400;
    uint32 internal constant EASY_REVEAL_BLOCKS = 79_200;
    uint32 internal constant EASY_CLAIM_BLOCKS = 237_600;
    uint32 internal constant EASY_EPOCH_CAPACITY = 999;

    uint32 internal constant HARD_COMMIT_BLOCKS = 316_800;
    uint32 internal constant HARD_REVEAL_BLOCKS = 158_400;
    uint32 internal constant HARD_CLAIM_BLOCKS = 237_600;
    uint32 internal constant HARD_EPOCH_CAPACITY = 666;

    uint32 internal constant HELL_COMMIT_BLOCKS = 633_600;
    uint32 internal constant HELL_REVEAL_BLOCKS = 316_800;
    uint32 internal constant HELL_CLAIM_BLOCKS = 237_600;
    uint32 internal constant HELL_EPOCH_CAPACITY = 333;

    uint16 internal constant PRESET_NFT_WALLET_LIMIT = 1;
    uint32 internal constant MIN_CUSTOM_PHASE_BLOCKS = 300;
    uint32 internal constant MAX_CUSTOM_PHASE_BLOCKS = 1_000_000;
    uint32 internal constant MIN_CUSTOM_CLAIM_BLOCKS = 1_200;
    // Leave ample margin inside ArbOS's 393,168-block history buffer.
    uint32 internal constant MAX_CUSTOM_CLAIM_BLOCKS = 237_600;
    uint16 internal constant MAX_CUSTOM_WALLET_LIMIT = 10;

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant BASE_TRADING_FEE_BPS = 100;
    uint16 internal constant MAX_CREATOR_BPS = 8_000;

    // The v4 graduation path ultimately narrows each seed amount to a signed
    // int128 delta. Registry validation additionally requires the phantom
    // reserve plus threshold to remain within this amount.
    uint256 internal constant MAX_GRADUATION_SEED_AMOUNT = uint256(uint128(type(int128).max));
    uint256 internal constant MAX_GRADUATION_TARGET = MAX_GRADUATION_SEED_AMOUNT;
}
