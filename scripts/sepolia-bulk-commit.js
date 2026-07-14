const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const count = Number(process.argv[4] || "0");
const outPath = process.argv[5] || "reports/sepolia-bulk-commit-400.json";
const funderKey = process.env.PRIVATE_KEY || "";

const MIN_CONFIRMATIONS = 1;
const FUND_BATCH_SIZE = 20;
const COMMIT_BATCH_SIZE = 10;
const FUND_BUFFER_BPS = 18000n;
const BPS = 10000n;

function usage() {
  console.error(
    [
      "Usage:",
      "  PRIVATE_KEY=... node scripts/sepolia-bulk-commit.js <rpcUrl> <gameAddress> <count> [outPath]",
      "",
      "Example:",
      "  PRIVATE_KEY=... node scripts/sepolia-bulk-commit.js https://ethereum-sepolia.publicnode.com 0xGame 400 reports/sepolia-bulk-commit-400.json",
    ].join("\n"),
  );
}

function readJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
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

function formatEth(value) {
  return ethers.formatEther(value);
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

function makeCommitment(address, epoch, secretHash) {
  return ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [address, epoch, secretHash]);
}

async function main() {
  if (!rpcUrl || !gameAddress || !count || !funderKey) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderKey, provider);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const funderGame = game.connect(funder);

  const epoch = await game.currentEpoch();
  const epochStart = await game.epochStart(epoch);
  const commitBlocks = await game.COMMIT_BLOCKS();
  const blockNumber = BigInt(await provider.getBlockNumber());
  if (!(blockNumber >= epochStart && blockNumber < epochStart + commitBlocks)) {
    throw new Error(`not commit phase: block ${blockNumber.toString()}`);
  }

  const existing = readJson(outPath, null);
  const secretsPath = secretsPathFor(outPath);
  const existingSecrets = readJson(secretsPath, null);
  const report = existing || {
    network: "sepolia",
    gameAddress,
    funder: funder.address,
    epoch: epoch.toString(),
    createdAt: new Date().toISOString(),
    wallets: [],
    funding: [],
    commits: [],
  };
  const secrets = existingSecrets || {
    network: "sepolia",
    gameAddress,
    funder: funder.address,
    epoch: epoch.toString(),
    createdAt: new Date().toISOString(),
    wallets: [],
  };

  if (report.wallets.length === 0) {
    for (let i = 0; i < count; i++) {
      const wallet = ethers.Wallet.createRandom();
      const secretHash = ethers.hexlify(ethers.randomBytes(32));
      report.wallets.push({
        index: i,
        address: wallet.address,
        commitment: makeCommitment(wallet.address, epoch, secretHash),
      });
      secrets.wallets.push({
        index: i,
        address: wallet.address,
        privateKey: wallet.privateKey,
        secretHash,
      });
    }
    writeJson(outPath, report);
    writeJson(secretsPath, secrets);
  }

  if (report.wallets.length !== count) {
    throw new Error(`existing report has ${report.wallets.length} wallets, expected ${count}`);
  }
  if (secrets.wallets.length !== count) {
    throw new Error(`secrets report has ${secrets.wallets.length} wallets, expected ${count}`);
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
  if (!maxFeePerGas) throw new Error("missing fee data");

  const sample = report.wallets.find((wallet) => !report.commits.some((commit) => commit.address === wallet.address));
  let commitGas = 60000n;
  if (sample) {
    try {
      commitGas = await funderGame.commitMint.estimateGas(sample.commitment);
    } catch {
      commitGas = 60000n;
    }
  }
  const fundAmount = (commitGas * maxFeePerGas * FUND_BUFFER_BPS) / BPS;
  const transferGas = 21000n;
  const unfunded = report.wallets.filter((wallet) => !report.funding.some((fund) => fund.address === wallet.address));
  const uncommitted = report.wallets.filter((wallet) => !report.commits.some((commit) => commit.address === wallet.address));
  const requiredForFunding = BigInt(unfunded.length) * (fundAmount + transferGas * maxFeePerGas);
  const funderBalance = await provider.getBalance(funder.address);

  report.estimate = {
    blockNumber: blockNumber.toString(),
    maxFeePerGasGwei: ethers.formatUnits(maxFeePerGas, "gwei"),
    commitGas: commitGas.toString(),
    fundAmountPerWalletEth: formatEth(fundAmount),
    unfunded: unfunded.length,
    uncommitted: uncommitted.length,
    requiredForRemainingFundingEth: formatEth(requiredForFunding),
    funderBalanceEth: formatEth(funderBalance),
    revealStartsAtBlock: (epochStart + commitBlocks).toString(),
  };
  writeJson(outPath, report);
  console.log(JSON.stringify({ step: "estimate", estimate: report.estimate }, null, 2));

  if (funderBalance < requiredForFunding) {
    throw new Error("insufficient funder balance for remaining funding");
  }

  if (unfunded.length > 0) {
    console.log(JSON.stringify({ step: "funding", count: unfunded.length, batchSize: FUND_BATCH_SIZE }, null, 2));
    let nonce = await provider.getTransactionCount(funder.address, "pending");
    for (let i = 0; i < unfunded.length; i += FUND_BATCH_SIZE) {
      const batch = unfunded.slice(i, i + FUND_BATCH_SIZE);
      const txs = await Promise.all(
        batch.map((wallet, offset) =>
          funder.sendTransaction({
            to: wallet.address,
            value: fundAmount,
            nonce: nonce + offset,
            maxFeePerGas: feeData.maxFeePerGas || undefined,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
            gasPrice: feeData.maxFeePerGas ? undefined : feeData.gasPrice,
          }),
        ),
      );
      nonce += batch.length;
      const receipts = await Promise.all(txs.map((tx) => tx.wait(MIN_CONFIRMATIONS)));
      for (let j = 0; j < batch.length; j++) {
        report.funding.push({
          index: batch[j].index,
          address: batch[j].address,
          amountEth: formatEth(fundAmount),
          tx: receipts[j].hash,
          blockNumber: receipts[j].blockNumber,
        });
      }
      writeJson(outPath, report);
      console.log(JSON.stringify({ step: "funded", total: report.funding.length }, null, 2));
    }
  }

  const stillUncommitted = report.wallets.filter((wallet) => !report.commits.some((commit) => commit.address === wallet.address));
  if (stillUncommitted.length > 0) {
    console.log(JSON.stringify({ step: "committing", count: stillUncommitted.length, batchSize: COMMIT_BATCH_SIZE }, null, 2));
    for (let i = 0; i < stillUncommitted.length; i += COMMIT_BATCH_SIZE) {
      const batch = stillUncommitted.slice(i, i + COMMIT_BATCH_SIZE);
      const receipts = await mapLimit(batch, COMMIT_BATCH_SIZE, async (entry) => {
        const secret = secrets.wallets.find((wallet) => wallet.address === entry.address);
        if (!secret) throw new Error(`missing secret for ${entry.address}`);
        const wallet = new ethers.Wallet(secret.privateKey, provider);
        const tx = await game.connect(wallet).commitMint(entry.commitment, {
          maxFeePerGas: feeData.maxFeePerGas || undefined,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
          gasPrice: feeData.maxFeePerGas ? undefined : feeData.gasPrice,
        });
        return tx.wait(MIN_CONFIRMATIONS);
      });
      for (let j = 0; j < batch.length; j++) {
        report.commits.push({
          index: batch[j].index,
          address: batch[j].address,
          commitment: batch[j].commitment,
          tx: receipts[j].hash,
          blockNumber: receipts[j].blockNumber,
        });
      }
      writeJson(outPath, report);
      console.log(JSON.stringify({ step: "committed", total: report.commits.length }, null, 2));
    }
  }

  report.completedAt = new Date().toISOString();
  report.summary = {
    wallets: report.wallets.length,
    funded: report.funding.length,
    committed: report.commits.length,
    epoch: epoch.toString(),
    revealStartsAtBlock: report.estimate.revealStartsAtBlock,
  };
  writeJson(outPath, report);
  console.log(JSON.stringify({ step: "done", summary: report.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
