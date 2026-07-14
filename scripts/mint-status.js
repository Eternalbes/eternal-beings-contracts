const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/mint-status.js <rpcUrl> <gameAddress> [userAddress]",
      "",
      "Reads current mint epoch/phase. If userAddress is provided, also reads that user's mint state.",
    ].join("\n"),
  );
}

function phaseOf(blockNumber, start, commitBlocks, epochBlocks) {
  if (blockNumber < start + commitBlocks) {
    return {
      phase: "commit",
      blocksUntilNextPhase: start + commitBlocks - blockNumber,
      nextPhase: "reveal",
    };
  }
  if (blockNumber < start + epochBlocks) {
    return {
      phase: "reveal",
      blocksUntilNextPhase: start + epochBlocks - blockNumber,
      nextPhase: "claim",
    };
  }
  return {
    phase: "claim",
    blocksUntilNextPhase: 0n,
    nextPhase: "next epoch",
  };
}

async function main() {
  const [rpcUrl, gameAddress, userAddress] = process.argv.slice(2);
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);

  const [blockNumberRaw, currentEpoch, epochBlocks, commitBlocks, totalMinted, maxBeings, mintsPerEpoch] = await Promise.all([
    provider.getBlockNumber(),
    game.currentEpoch(),
    game.EPOCH_BLOCKS(),
    game.COMMIT_BLOCKS(),
    game.totalMinted(),
    game.MAX_BEINGS(),
    game.MINTS_PER_EPOCH(),
  ]);
  const blockNumber = BigInt(blockNumberRaw);
  const epochStart = await game.epochStart(currentEpoch);
  const phase = phaseOf(blockNumber, epochStart, commitBlocks, epochBlocks);
  const releasedMintCap = await game.releasedMintCap(currentEpoch);
  const remainingReleasedMints = releasedMintCap > totalMinted ? releasedMintCap - totalMinted : 0n;

  const output = {
    gameAddress,
    blockNumber: blockNumber.toString(),
    currentEpoch: currentEpoch.toString(),
    epochStart: epochStart.toString(),
    phase: phase.phase,
    nextPhase: phase.nextPhase,
    blocksUntilNextPhase: phase.blocksUntilNextPhase.toString(),
    epochBlocks: epochBlocks.toString(),
    commitBlocks: commitBlocks.toString(),
    mintsPerEpoch: mintsPerEpoch.toString(),
    totalMinted: totalMinted.toString(),
    maxBeings: maxBeings.toString(),
    releasedMintCap: releasedMintCap.toString(),
    remainingReleasedMints: remainingReleasedMints.toString(),
  };

  if (userAddress) {
    const user = ethers.getAddress(userAddress.toLowerCase());
    const [commitment, revealed, claimedEpoch, hasMintedBeing] = await Promise.all([
      game.commitments(currentEpoch, user),
      game.revealed(currentEpoch, user),
      game.claimedEpoch(currentEpoch, user),
      game.hasMintedBeing(user),
    ]);
    output.user = {
      address: user,
      commitment,
      hasCommittedThisEpoch: commitment !== ethers.ZeroHash,
      revealedThisEpoch: revealed,
      claimedThisEpoch: claimedEpoch,
      hasMintedBeing,
      suggestedAction: hasMintedBeing
        ? "already minted"
        : phase.phase === "commit"
          ? commitment === ethers.ZeroHash
            ? "compute commitment and call commitMint"
            : "wait for reveal phase"
          : phase.phase === "reveal"
            ? revealed
              ? "wait for claim phase"
              : "call revealMint with epoch and secretHash"
            : revealed && !claimedEpoch
              ? "call claimMint"
              : "not claimable in this epoch",
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
