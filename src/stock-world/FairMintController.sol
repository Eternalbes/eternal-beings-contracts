// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWorldNftMinter {
    function maxSupply() external view returns (uint32);
    function mintFromController(address to, bytes32 genome) external returns (uint256 tokenId);
}

/**
 * @title FairMintController
 * @notice Gas-only repeating commit/reveal distribution for one WorldNFT.
 * @dev Future-block entropy selects one exact circular interval of revealers,
 *      avoiding holder iteration and first-claim races between valid winners.
 */
contract FairMintController {
    struct EpochState {
        bytes32 revealEntropy;
        bytes32 finalSeed;
        uint64 claimDeadline;
        uint32 revealedCount;
        uint32 winnerCount;
        uint32 claimedCount;
        uint32 winnerStartIndex;
        bool finalized;
        bool expired;
        bool usedLateEntropy;
    }

    IWorldNftMinter public immutable worldNft;
    uint64 public immutable startBlock;
    uint32 public immutable commitBlocks;
    uint32 public immutable revealBlocks;
    uint32 public immutable claimBlocks;
    uint32 public immutable epochCapacity;
    uint16 public immutable walletLimit;
    uint32 public immutable maxSupply;

    uint32 public totalMinted;
    uint32 public totalReserved;

    mapping(uint256 epoch => EpochState state) private epochs;
    mapping(uint256 epoch => mapping(address account => bytes32 commitment)) public commitments;
    mapping(uint256 epoch => mapping(address account => uint32 oneBasedIndex)) public revealerIndex;
    mapping(uint256 epoch => mapping(address account => bool claimed)) public claimed;
    mapping(address account => uint16 count) public mintedByWallet;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidParameters();
    error WrongCommitPhase();
    error WrongRevealPhase();
    error ZeroCommitment();
    error AlreadyCommitted();
    error MaxSupplyReached();
    error InvalidSecret();
    error AlreadyRevealed();
    error EntropyBlockNotReady();
    error AlreadyFinalized();
    error EpochNotFinalized();
    error EpochExpired();
    error ClaimWindowOpen();
    error NotRevealed();
    error NotWinner();
    error AlreadyClaimed();
    error WalletLimitReached();
    error ReentrantCall();

    event MintCommitted(uint256 indexed epoch, address indexed account, bytes32 commitment);
    event MintRevealed(uint256 indexed epoch, address indexed account, uint32 revealerIndex);
    event EpochFinalized(
        uint256 indexed epoch,
        bytes32 seed,
        uint32 revealedCount,
        uint32 winnerCount,
        uint32 winnerStartIndex,
        uint64 claimDeadline,
        bool usedLateEntropy
    );
    event NFTClaimed(uint256 indexed epoch, address indexed account, uint256 indexed tokenId, bytes32 genome);
    event EpochExpiredEvent(uint256 indexed epoch, uint32 releasedReservations);

    constructor(
        IWorldNftMinter worldNft_,
        uint32 maxSupply_,
        uint32 commitBlocks_,
        uint32 revealBlocks_,
        uint32 claimBlocks_,
        uint32 epochCapacity_,
        uint16 walletLimit_
    ) {
        if (address(worldNft_) == address(0)) revert ZeroAddress();
        if (address(worldNft_).code.length == 0) revert NotContract();
        if (
            maxSupply_ == 0 || worldNft_.maxSupply() != maxSupply_ || commitBlocks_ == 0 || revealBlocks_ == 0
                || claimBlocks_ == 0
                || epochCapacity_ == 0 || epochCapacity_ > maxSupply_ || walletLimit_ == 0
                || walletLimit_ > maxSupply_
        ) revert InvalidParameters();

        worldNft = worldNft_;
        maxSupply = maxSupply_;
        startBlock = uint64(block.number);
        commitBlocks = commitBlocks_;
        revealBlocks = revealBlocks_;
        claimBlocks = claimBlocks_;
        epochCapacity = epochCapacity_;
        walletLimit = walletLimit_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function currentEpoch() public view returns (uint256) {
        return (block.number - uint256(startBlock)) / epochLength();
    }

    function epochLength() public view returns (uint256) {
        return uint256(commitBlocks) + uint256(revealBlocks);
    }

    function epochStart(uint256 epoch) public view returns (uint256) {
        return uint256(startBlock) + epoch * epochLength();
    }

    function entropyBlock(uint256 epoch) public view returns (uint256) {
        return epochStart(epoch) + epochLength();
    }

    function computeCommitment(address account, uint256 epoch, bytes32 secret) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, account, epoch, secret));
    }

    function commitMint(bytes32 commitment) external {
        uint256 epoch = currentEpoch();
        uint256 start = epochStart(epoch);
        if (block.number < start || block.number >= start + commitBlocks) revert WrongCommitPhase();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (commitments[epoch][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (uint256(totalMinted) + uint256(totalReserved) >= uint256(maxSupply)) {
            revert MaxSupplyReached();
        }
        if (mintedByWallet[msg.sender] >= walletLimit) revert WalletLimitReached();

        commitments[epoch][msg.sender] = commitment;
        emit MintCommitted(epoch, msg.sender, commitment);
    }

    function revealMint(uint256 epoch, bytes32 secret) external {
        uint256 start = epochStart(epoch);
        uint256 revealStart = start + commitBlocks;
        if (block.number < revealStart || block.number >= entropyBlock(epoch)) revert WrongRevealPhase();
        if (revealerIndex[epoch][msg.sender] != 0) revert AlreadyRevealed();
        if (commitments[epoch][msg.sender] != computeCommitment(msg.sender, epoch, secret)) {
            revert InvalidSecret();
        }

        EpochState storage state = epochs[epoch];
        uint32 index = ++state.revealedCount;
        revealerIndex[epoch][msg.sender] = index;
        state.revealEntropy = keccak256(abi.encode(state.revealEntropy, msg.sender, secret, index));
        emit MintRevealed(epoch, msg.sender, index);
    }

    function finalizeEpoch(uint256 epoch) external {
        EpochState storage state = epochs[epoch];
        if (state.finalized) revert AlreadyFinalized();

        uint256 targetBlock = entropyBlock(epoch);
        if (block.number <= targetBlock) revert EntropyBlockNotReady();

        bytes32 futureHash = blockhash(targetBlock);
        bool late = futureHash == bytes32(0);
        bytes32 seed = late
            ? keccak256(
                abi.encode(
                    state.revealEntropy,
                    epoch,
                    address(this),
                    block.prevrandao,
                    blockhash(block.number - 1),
                    "LATE_ENTROPY"
                )
            )
            : keccak256(abi.encode(state.revealEntropy, epoch, address(this), futureHash));

        uint256 available = uint256(maxSupply) - uint256(totalMinted) - uint256(totalReserved);
        uint256 winners = state.revealedCount;
        if (winners > epochCapacity) winners = epochCapacity;
        if (winners > available) winners = available;

        state.finalSeed = seed;
        state.winnerCount = uint32(winners);
        state.winnerStartIndex = state.revealedCount == 0 ? 0 : uint32(uint256(seed) % state.revealedCount);
        state.claimDeadline = uint64(block.number + claimBlocks);
        state.finalized = true;
        state.usedLateEntropy = late;
        totalReserved += uint32(winners);

        emit EpochFinalized(
            epoch,
            seed,
            state.revealedCount,
            state.winnerCount,
            state.winnerStartIndex,
            state.claimDeadline,
            late
        );
    }

    function claimMint(uint256 epoch) external nonReentrant returns (uint256 tokenId) {
        EpochState storage state = epochs[epoch];
        if (!state.finalized) revert EpochNotFinalized();
        if (state.expired || block.number > state.claimDeadline) revert EpochExpired();
        if (revealerIndex[epoch][msg.sender] == 0) revert NotRevealed();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();
        if (!isWinner(epoch, msg.sender)) revert NotWinner();
        if (mintedByWallet[msg.sender] >= walletLimit) revert WalletLimitReached();

        claimed[epoch][msg.sender] = true;
        state.claimedCount += 1;
        totalReserved -= 1;
        totalMinted += 1;
        mintedByWallet[msg.sender] += 1;

        bytes32 genome = keccak256(
            abi.encode(state.finalSeed, msg.sender, epoch, revealerIndex[epoch][msg.sender], totalMinted)
        );
        tokenId = worldNft.mintFromController(msg.sender, genome);
        emit NFTClaimed(epoch, msg.sender, tokenId, genome);
    }

    function expireEpoch(uint256 epoch) external returns (uint32 releasedReservations) {
        EpochState storage state = epochs[epoch];
        if (!state.finalized) revert EpochNotFinalized();
        if (state.expired) revert EpochExpired();
        if (block.number <= state.claimDeadline) revert ClaimWindowOpen();

        state.expired = true;
        releasedReservations = state.winnerCount - state.claimedCount;
        totalReserved -= releasedReservations;
        emit EpochExpiredEvent(epoch, releasedReservations);
    }

    function isWinner(uint256 epoch, address account) public view returns (bool) {
        EpochState memory state = epochs[epoch];
        uint256 oneBased = revealerIndex[epoch][account];
        if (!state.finalized || oneBased == 0 || state.winnerCount == 0) return false;

        uint256 index = oneBased - 1;
        uint256 distance = (index + state.revealedCount - state.winnerStartIndex) % state.revealedCount;
        return distance < state.winnerCount;
    }

    function epochState(uint256 epoch) external view returns (EpochState memory) {
        return epochs[epoch];
    }
}
