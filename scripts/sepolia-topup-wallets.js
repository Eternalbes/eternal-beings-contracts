const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const reportPath = process.argv[3] || "reports/sepolia-bulk-commit-400.json";
const amountEth = process.argv[4] || "0.0004";
const funderKey = process.env.PRIVATE_KEY || "";

const BATCH_SIZE = 20;
const MIN_CONFIRMATIONS = 1;

function usage() {
  console.error(
    [
      "Usage:",
      "  PRIVATE_KEY=... node scripts/sepolia-topup-wallets.js <rpcUrl> <publicReportPath> <amountEth>",
      "",
      "Example:",
      "  PRIVATE_KEY=... node scripts/sepolia-topup-wallets.js https://ethereum-sepolia.publicnode.com reports/sepolia-bulk-commit-400.json 0.0004",
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

function topupReportPathFor(path, amount) {
  const suffix = amount.replace(/[^0-9a-zA-Z]+/g, "_");
  return path.replace(/\.json$/, `.topups-${suffix}.json`);
}

async function main() {
  if (!rpcUrl || !reportPath || !amountEth || !funderKey) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderKey, provider);
  const publicReport = readJson(reportPath);
  const topupReportPath = topupReportPathFor(reportPath, amountEth);
  const topupReport = readJson(topupReportPath, {
    network: publicReport.network,
    funder: funder.address,
    amountEth,
    createdAt: new Date().toISOString(),
    topups: [],
  });

  const amount = ethers.parseEther(amountEth);
  const done = new Set(topupReport.topups.map((entry) => entry.address.toLowerCase()));
  const remaining = publicReport.wallets.filter((wallet) => !done.has(wallet.address.toLowerCase()));
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  const required = BigInt(remaining.length) * (amount + 21000n * gasPrice);
  const balance = await provider.getBalance(funder.address);

  console.log(
    JSON.stringify(
      {
        step: "estimate",
        wallets: publicReport.wallets.length,
        remaining: remaining.length,
        amountEth,
        requiredEth: ethers.formatEther(required),
        funderBalanceEth: ethers.formatEther(balance),
      },
      null,
      2,
    ),
  );

  if (balance < required) throw new Error("insufficient funder balance");

  let nonce = await provider.getTransactionCount(funder.address, "pending");
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const txs = await Promise.all(
      batch.map((wallet, offset) =>
        funder.sendTransaction({
          to: wallet.address,
          value: amount,
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
      topupReport.topups.push({
        index: batch[j].index,
        address: batch[j].address,
        amountEth,
        tx: receipts[j].hash,
        blockNumber: receipts[j].blockNumber,
      });
    }
    writeJson(topupReportPath, topupReport);
    console.log(JSON.stringify({ step: "topped-up", total: topupReport.topups.length }, null, 2));
  }

  topupReport.completedAt = new Date().toISOString();
  topupReport.summary = {
    wallets: publicReport.wallets.length,
    toppedUp: topupReport.topups.length,
    amountEth,
  };
  writeJson(topupReportPath, topupReport);
  console.log(JSON.stringify({ step: "done", summary: topupReport.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
