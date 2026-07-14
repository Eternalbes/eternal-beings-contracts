const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const publicReportPath = process.argv[4] || "reports/sepolia-bulk-commit-400.json";
const limit = Number(process.argv[5] || "0");

const READ_BATCH_SIZE = 25;

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-bulk-status.js <rpcUrl> <gameAddress> <publicReportPath> [limit]",
      "",
      "Example:",
      "  node scripts/sepolia-bulk-status.js https://ethereum-sepolia.publicnode.com 0xGame reports/sepolia-bulk-commit-400.json",
    ].join("\n"),
  );
}

function readJson(path, fallback = undefined) {
  if (!fs.existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing file: ${path}`);
  }
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function maybeRead(path) {
  return readJson(path, {});
}

function revealReportPathFor(path) {
  return path.replace(/\.json$/, ".reveal.json");
}

function claimReportPathFor(path) {
  return path.replace(/\.json$/, ".claim.json");
}

async function mapLimit(items, limitCount, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limitCount, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!rpcUrl || !gameAddress || !publicReportPath) {
    usage();
    process.exit(1);
  }

  const publicReport = readJson(publicReportPath);
  const revealReport = maybeRead(revealReportPathFor(publicReportPath));
  const claimReport = maybeRead(claimReportPathFor(publicReportPath));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const epoch = BigInt(publicReport.epoch);
  const wallets = limit > 0 ? publicReport.wallets.slice(0, limit) : publicReport.wallets;

  const [blockNumberRaw, currentEpoch, epochStart, commitBlocks, epochBlocks, totalMinted, aliveSupply, revealedCount, epochClaimLimit, epochClaimedCount] =
    await Promise.all([
      provider.getBlockNumber(),
      game.currentEpoch(),
      game.epochStart(epoch),
      game.COMMIT_BLOCKS(),
      game.EPOCH_BLOCKS(),
      game.totalMinted(),
      game.aliveSupply(),
      game.revealedCount(epoch),
      game.epochClaimLimit(epoch),
      game.epochClaimedCount(epoch),
    ]);

  const blockNumber = BigInt(blockNumberRaw);
  const revealStartsAtBlock = epochStart + commitBlocks;
  const claimStartsAtBlock = epochStart + epochBlocks;
  const phase = blockNumber < revealStartsAtBlock ? "commit" : blockNumber < claimStartsAtBlock ? "reveal" : "claim";

  const rows = await mapLimit(wallets, READ_BATCH_SIZE, async (wallet) => {
    const [chainCommitment, revealed, claimed, minted] = await Promise.all([
      game.commitments(epoch, wallet.address),
      game.revealed(epoch, wallet.address),
      game.claimedEpoch(epoch, wallet.address),
      game.hasMintedBeing(wallet.address),
    ]);
    return {
      address: wallet.address,
      committed: chainCommitment !== ethers.ZeroHash,
      commitmentMatches: chainCommitment.toLowerCase() === wallet.commitment.toLowerCase(),
      revealed,
      claimed,
      minted,
    };
  });

  const revealTxAddresses = new Set((revealReport.reveals || []).map((entry) => entry.address.toLowerCase()));
  const claimTxAddresses = new Set((claimReport.claims || []).map((entry) => entry.address.toLowerCase()));
  const failedClaimAddresses = new Set((claimReport.failures || []).map((entry) => entry.address.toLowerCase()));

  const summary = {
    blockNumber: blockNumber.toString(),
    phase,
    blocksUntilReveal: blockNumber < revealStartsAtBlock ? (revealStartsAtBlock - blockNumber).toString() : "0",
    blocksUntilClaim: blockNumber < claimStartsAtBlock ? (claimStartsAtBlock - blockNumber).toString() : "0",
    epoch: epoch.toString(),
    currentEpoch: currentEpoch.toString(),
    revealStartsAtBlock: revealStartsAtBlock.toString(),
    claimStartsAtBlock: claimStartsAtBlock.toString(),
    sampledWallets: rows.length,
    reportWallets: publicReport.wallets.length,
    committed: rows.filter((row) => row.committed).length,
    commitmentMismatches: rows.filter((row) => !row.commitmentMatches).length,
    revealed: rows.filter((row) => row.revealed).length,
    claimed: rows.filter((row) => row.claimed).length,
    minted: rows.filter((row) => row.minted).length,
    revealTxsInReport: revealTxAddresses.size,
    claimTxsInReport: claimTxAddresses.size,
    failedClaimsInReport: failedClaimAddresses.size,
    totalMinted: totalMinted.toString(),
    aliveSupply: aliveSupply.toString(),
    revealedCount: revealedCount.toString(),
    epochClaimLimit: epochClaimLimit.toString(),
    epochClaimedCount: epochClaimedCount.toString(),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
