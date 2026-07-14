const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const publicReportPath = process.argv[4] || "reports/sepolia-bulk-commit-400.json";
const mode = process.argv[5] || "dry-run";

const CLAIM_BATCH_SIZE = 3;
const MIN_CONFIRMATIONS = 1;
const CLAIM_GAS_LIMIT = 500000n;

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-bulk-claim.js <rpcUrl> <gameAddress> <publicReportPath> [dry-run|broadcast]",
      "",
      "Example:",
      "  node scripts/sepolia-bulk-claim.js https://ethereum-sepolia.publicnode.com 0xGame reports/sepolia-bulk-commit-400.json dry-run",
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

function writeJson(path, value) {
  fs.mkdirSync(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function secretsPathFor(path) {
  const parts = path.split("/");
  const file = parts.pop() || "sepolia-bulk-commit.json";
  return [...parts, "secrets", file.replace(/\.json$/, ".secrets.json")].join("/");
}

function claimReportPathFor(path) {
  return path.replace(/\.json$/, ".claim.json");
}

function revealReportPathFor(path) {
  return path.replace(/\.json$/, ".reveal.json");
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

function joinEntries(publicReport, secrets, revealReport) {
  const bySecret = new Map(secrets.wallets.map((entry) => [entry.address.toLowerCase(), entry]));
  const revealed = new Set((revealReport.reveals || []).map((entry) => entry.address.toLowerCase()));
  return publicReport.wallets.map((entry) => {
    const secret = bySecret.get(entry.address.toLowerCase());
    if (!secret) throw new Error(`missing secret for ${entry.address}`);
    return {
      ...entry,
      privateKey: secret.privateKey,
      hasRevealTx: revealed.has(entry.address.toLowerCase()),
    };
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
  const revealReport = readJson(revealReportPathFor(publicReportPath), { reveals: [] });
  const entries = joinEntries(publicReport, secrets, revealReport);
  const epoch = BigInt(publicReport.epoch);

  const epochStart = await game.epochStart(epoch);
  const epochBlocks = await game.EPOCH_BLOCKS();
  const blockNumber = BigInt(await provider.getBlockNumber());
  const claimStarted = blockNumber >= epochStart + epochBlocks;
  const status = {
    mode,
    blockNumber: blockNumber.toString(),
    epoch: epoch.toString(),
    claimStartsAtBlock: (epochStart + epochBlocks).toString(),
    claimStarted,
    wallets: entries.length,
    revealReportEntries: revealReport.reveals.length || 0,
  };
  console.log(JSON.stringify({ step: "status", status }, null, 2));

  const sampleSize = mode === "dry-run" && !claimStarted ? Math.min(25, entries.length) : entries.length;
  const dryRunEntries = entries.slice(0, sampleSize);
  const dryRun = await mapLimit(dryRunEntries, CLAIM_BATCH_SIZE, async (entry) => {
    const wallet = new ethers.Wallet(entry.privateKey, provider);
    const [revealed, claimed, minted] = await Promise.all([
      game.revealed(epoch, entry.address),
      game.claimedEpoch(epoch, entry.address),
      game.hasMintedBeing(entry.address),
    ]);
    try {
      await game.connect(wallet).claimMint.staticCall(epoch);
      return { index: entry.index, address: entry.address, ok: true, revealed, claimed, minted, hasRevealTx: entry.hasRevealTx };
    } catch (error) {
      return {
        index: entry.index,
        address: entry.address,
        ok: false,
        revealed,
        claimed,
        minted,
        hasRevealTx: entry.hasRevealTx,
        reason: errorReason(error),
      };
    }
  });

  const dryRunSummary = {
    checked: dryRun.length,
    ok: dryRun.filter((entry) => entry.ok).length,
    reverted: dryRun.filter((entry) => !entry.ok).length,
    revealed: dryRun.filter((entry) => entry.revealed).length,
    claimed: dryRun.filter((entry) => entry.claimed).length,
    minted: dryRun.filter((entry) => entry.minted).length,
    withRevealTx: dryRun.filter((entry) => entry.hasRevealTx).length,
    sampleRevertReasons: [...new Set(dryRun.filter((entry) => !entry.ok).map((entry) => entry.reason))].slice(0, 8),
  };
  console.log(JSON.stringify({ step: "dry-run", summary: dryRunSummary }, null, 2));

  if (mode === "dry-run") {
    return;
  }
  if (!claimStarted) {
    throw new Error("claim not started; refusing to broadcast");
  }

  const claimReportPath = claimReportPathFor(publicReportPath);
  const claimReport = fs.existsSync(claimReportPath)
    ? readJson(claimReportPath)
    : {
        network: publicReport.network,
        gameAddress,
        epoch: epoch.toString(),
        createdAt: new Date().toISOString(),
        claims: [],
        failures: [],
      };

  const retryable = new Set(["insufficient funds for intrinsic transaction cost", "transaction execution reverted"]);
  claimReport.failures = (claimReport.failures || []).filter((entry) => !retryable.has(entry.reason));
  const dryRunOk = new Set(dryRun.filter((entry) => entry.ok).map((entry) => entry.address.toLowerCase()));
  const done = new Set([...claimReport.claims, ...claimReport.failures].map((entry) => entry.address.toLowerCase()));
  const remaining = entries.filter((entry) => dryRunOk.has(entry.address.toLowerCase()) && !done.has(entry.address.toLowerCase()));
  console.log(JSON.stringify({ step: "broadcast", remaining: remaining.length, batchSize: CLAIM_BATCH_SIZE }, null, 2));

  const feeData = await provider.getFeeData();
  const claimGasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  for (let i = 0; i < remaining.length; i += CLAIM_BATCH_SIZE) {
    const batch = remaining.slice(i, i + CLAIM_BATCH_SIZE);
    const results = await mapLimit(batch, CLAIM_BATCH_SIZE, async (entry) => {
      const wallet = new ethers.Wallet(entry.privateKey, provider);
      try {
        const tx = await game.connect(wallet).claimMint(epoch, {
          gasLimit: CLAIM_GAS_LIMIT,
          gasPrice: claimGasPrice,
        });
        const receipt = await tx.wait(MIN_CONFIRMATIONS);
        const mintedEvent = receipt.logs
          .map((log) => {
            try {
              return game.interface.parseLog(log);
            } catch {
              return null;
            }
          })
          .find((event) => event && event.name === "BeingMinted");
        return {
          ok: true,
          tx: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          tokenId: mintedEvent ? mintedEvent.args.tokenId.toString() : null,
        };
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
      if (entry.ok) claimReport.claims.push(entry);
      else claimReport.failures.push(entry);
    }
    writeJson(claimReportPath, claimReport);
    console.log(
      JSON.stringify(
        { step: "claimed", successes: claimReport.claims.length, failures: claimReport.failures.length },
        null,
        2,
      ),
    );
  }

  claimReport.completedAt = new Date().toISOString();
  claimReport.summary = {
    wallets: entries.length,
    claimed: claimReport.claims.length,
    failures: claimReport.failures.length,
    epoch: epoch.toString(),
  };
  writeJson(claimReportPath, claimReport);
  console.log(JSON.stringify({ step: "done", summary: claimReport.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
