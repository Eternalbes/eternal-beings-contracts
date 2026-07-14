const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const publicReportPath = process.argv[4] || "reports/sepolia-bulk-commit-400.json";
const mode = process.argv[5] || "dry-run";

const REVEAL_BATCH_SIZE = 10;
const MIN_CONFIRMATIONS = 1;
const REVEAL_GAS_LIMIT = 220000n;

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-bulk-reveal.js <rpcUrl> <gameAddress> <publicReportPath> [dry-run|broadcast]",
      "",
      "Example:",
      "  node scripts/sepolia-bulk-reveal.js https://ethereum-sepolia.publicnode.com 0xGame reports/sepolia-bulk-commit-400.json dry-run",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  fs.mkdirSync(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function secretsPathFor(path) {
  const parts = path.split("/");
  const file = parts.pop() || "sepolia-bulk-commit.json";
  return [...parts, "secrets", file.replace(/\.json$/, ".secrets.json")].join("/");
}

function revealReportPathFor(path) {
  return path.replace(/\.json$/, ".reveal.json");
}

function makeCommitment(address, epoch, secretHash) {
  return ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [address, epoch, secretHash]);
}

function errorReason(error) {
  return error.shortMessage || error.reason || error.message || String(error);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function joinEntries(publicReport, secrets) {
  const byAddress = new Map(secrets.wallets.map((entry) => [entry.address.toLowerCase(), entry]));
  return publicReport.wallets.map((entry) => {
    const secret = byAddress.get(entry.address.toLowerCase());
    if (!secret) throw new Error(`missing secret for ${entry.address}`);
    const expected = makeCommitment(entry.address, publicReport.epoch, secret.secretHash);
    if (expected.toLowerCase() !== entry.commitment.toLowerCase()) {
      throw new Error(`commitment mismatch for ${entry.address}`);
    }
    return { ...entry, privateKey: secret.privateKey, secretHash: secret.secretHash };
  });
}

async function main() {
  if (!rpcUrl || !gameAddress || !publicReportPath || !["dry-run", "broadcast"].includes(mode)) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const publicReport = readJson(publicReportPath);
  const secrets = readJson(secretsPathFor(publicReportPath));
  const entries = joinEntries(publicReport, secrets);
  const epoch = BigInt(publicReport.epoch);

  const currentEpoch = await game.currentEpoch();
  const epochStart = await game.epochStart(epoch);
  const commitBlocks = await game.COMMIT_BLOCKS();
  const epochBlocks = await game.EPOCH_BLOCKS();
  const blockNumber = BigInt(await provider.getBlockNumber());
  const inRevealPhase = blockNumber >= epochStart + commitBlocks && blockNumber < epochStart + epochBlocks;
  const status = {
    mode,
    blockNumber: blockNumber.toString(),
    epoch: epoch.toString(),
    currentEpoch: currentEpoch.toString(),
    revealStartsAtBlock: (epochStart + commitBlocks).toString(),
    claimStartsAtBlock: (epochStart + epochBlocks).toString(),
    inRevealPhase,
    wallets: entries.length,
  };
  console.log(JSON.stringify({ step: "status", status }, null, 2));

  const sampleSize = mode === "dry-run" && !inRevealPhase ? Math.min(25, entries.length) : entries.length;
  const dryRunEntries = entries.slice(0, sampleSize);
  const dryRun = await mapLimit(dryRunEntries, REVEAL_BATCH_SIZE, async (entry) => {
    const wallet = new ethers.Wallet(entry.privateKey, provider);
    const chainCommitment = await game.commitments(epoch, entry.address);
    const alreadyRevealed = await game.revealed(epoch, entry.address);
    const matchesChain = chainCommitment.toLowerCase() === entry.commitment.toLowerCase();
    try {
      await game.connect(wallet).revealMint.staticCall(epoch, entry.secretHash);
      return { index: entry.index, address: entry.address, ok: true, matchesChain, alreadyRevealed };
    } catch (error) {
      return {
        index: entry.index,
        address: entry.address,
        ok: false,
        matchesChain,
        alreadyRevealed,
        reason: errorReason(error),
      };
    }
  });

  const dryRunSummary = {
    checked: dryRun.length,
    ok: dryRun.filter((entry) => entry.ok).length,
    reverted: dryRun.filter((entry) => !entry.ok).length,
    chainCommitmentMismatches: dryRun.filter((entry) => !entry.matchesChain).length,
    alreadyRevealed: dryRun.filter((entry) => entry.alreadyRevealed).length,
    sampleRevertReasons: [...new Set(dryRun.filter((entry) => !entry.ok).map((entry) => entry.reason))].slice(0, 5),
  };
  console.log(JSON.stringify({ step: "dry-run", summary: dryRunSummary }, null, 2));

  if (mode === "dry-run") {
    return;
  }
  if (!inRevealPhase) {
    throw new Error("not reveal phase; refusing to broadcast");
  }

  const revealReportPath = revealReportPathFor(publicReportPath);
  const revealReport = fs.existsSync(revealReportPath)
    ? readJson(revealReportPath)
      : {
        network: publicReport.network,
        gameAddress,
        epoch: epoch.toString(),
        createdAt: new Date().toISOString(),
        reveals: [],
        failures: [],
      };

  const remaining = entries.filter((entry) => !revealReport.reveals.some((reveal) => reveal.address === entry.address));
  console.log(JSON.stringify({ step: "broadcast", remaining: remaining.length, batchSize: REVEAL_BATCH_SIZE }, null, 2));

  const feeData = await provider.getFeeData();
  for (let i = 0; i < remaining.length; i += REVEAL_BATCH_SIZE) {
    const batch = remaining.slice(i, i + REVEAL_BATCH_SIZE);
    const results = await mapLimit(batch, REVEAL_BATCH_SIZE, async (entry) => {
      const wallet = new ethers.Wallet(entry.privateKey, provider);
      try {
        const tx = await game.connect(wallet).revealMint(epoch, entry.secretHash, {
          gasLimit: REVEAL_GAS_LIMIT,
          maxFeePerGas: feeData.maxFeePerGas || undefined,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
          gasPrice: feeData.maxFeePerGas ? undefined : feeData.gasPrice,
        });
        const receipt = await tx.wait(MIN_CONFIRMATIONS);
        return { ok: true, tx: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
      } catch (error) {
        return { ok: false, reason: errorReason(error) };
      }
    });

    for (let j = 0; j < batch.length; j++) {
      const entry = {
        index: batch[j].index,
        address: batch[j].address,
        commitment: batch[j].commitment,
        ...results[j],
      };
      if (entry.ok) revealReport.reveals.push(entry);
      else revealReport.failures.push(entry);
    }
    writeJson(revealReportPath, revealReport);
    console.log(
      JSON.stringify(
        { step: "revealed", successes: revealReport.reveals.length, failures: revealReport.failures.length },
        null,
        2,
      ),
    );
  }

  revealReport.completedAt = new Date().toISOString();
  revealReport.summary = {
    wallets: entries.length,
    revealed: revealReport.reveals.length,
    failures: revealReport.failures.length,
    epoch: epoch.toString(),
    claimStartsAtBlock: status.claimStartsAtBlock,
  };
  writeJson(revealReportPath, revealReport);
  console.log(JSON.stringify({ step: "done", summary: revealReport.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
