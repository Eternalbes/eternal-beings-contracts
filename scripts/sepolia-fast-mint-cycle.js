const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const count = Number(process.argv[4] || "2");
const outPath = process.argv[5] || "reports/sepolia-fast-mint-cycle.json";
const funderKey = process.env.PRIVATE_KEY || "";

const MIN_CONFIRMATIONS = 1;
const COMMIT_GAS_LIMIT = 80000n;
const REVEAL_GAS_LIMIT = 220000n;
const CLAIM_GAS_LIMIT = 500000n;

function usage() {
  console.error(
    [
      "Usage:",
      "  PRIVATE_KEY=... node scripts/sepolia-fast-mint-cycle.js <rpcUrl> <gameAddress> [count] [outPath]",
      "",
      "Generates temporary wallets, funds them before the next commit window, then runs commit/reveal/claim.",
    ].join("\n"),
  );
}

function writeJson(path, value) {
  fs.mkdirSync(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function secretsPathFor(path) {
  const parts = path.split("/");
  const file = parts.pop() || "sepolia-fast-mint-cycle.json";
  return [...parts, "secrets", file.replace(/\.json$/, ".secrets.json")].join("/");
}

function makeCommitment(address, epoch, secretHash) {
  return ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [address, epoch, secretHash]);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function blockStatus(provider, game) {
  const [blockNumberRaw, epoch, commitBlocks, epochBlocks] = await Promise.all([
    provider.getBlockNumber(),
    game.currentEpoch(),
    game.COMMIT_BLOCKS(),
    game.EPOCH_BLOCKS(),
  ]);
  const blockNumber = BigInt(blockNumberRaw);
  const epochStart = await game.epochStart(epoch);
  const commitStart = epochStart;
  const revealStart = epochStart + commitBlocks;
  const claimStart = epochStart + epochBlocks;
  return {
    blockNumber,
    epoch,
    epochStart,
    commitStart,
    revealStart,
    claimStart,
    inCommit: blockNumber >= commitStart && blockNumber < revealStart,
    inReveal: blockNumber >= revealStart && blockNumber < claimStart,
    claimStarted: blockNumber >= claimStart,
  };
}

async function waitFor(provider, game, predicate, label) {
  for (;;) {
    const status = await blockStatus(provider, game);
    if (predicate(status)) return status;
    console.log(JSON.stringify({ step: "wait", label, blockNumber: status.blockNumber.toString(), epoch: status.epoch.toString() }));
    await sleep(3000);
  }
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

async function main() {
  if (!rpcUrl || !gameAddress || !count || !funderKey) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderKey, provider);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  if (!gasPrice) throw new Error("missing fee data");

  const wallets = [];
  const secrets = {
    network: "sepolia",
    gameAddress,
    funder: funder.address,
    createdAt: new Date().toISOString(),
    wallets: [],
  };
  const report = {
    network: "sepolia",
    gameAddress,
    funder: funder.address,
    createdAt: secrets.createdAt,
    wallets: [],
    funding: [],
    commits: [],
    reveals: [],
    claims: [],
  };

  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom();
    const secretHash = ethers.hexlify(ethers.randomBytes(32));
    wallets.push({ index: i, wallet, secretHash });
    secrets.wallets.push({ index: i, address: wallet.address, privateKey: wallet.privateKey, secretHash });
    report.wallets.push({ index: i, address: wallet.address });
  }

  const fundAmount = (CLAIM_GAS_LIMIT + REVEAL_GAS_LIMIT + COMMIT_GAS_LIMIT + 120000n) * gasPrice * 2n;
  console.log(JSON.stringify({ step: "fund", count, fundAmountEth: ethers.formatEther(fundAmount) }, null, 2));
  let nonce = await provider.getTransactionCount(funder.address, "pending");
  const fundingTxs = await Promise.all(
    wallets.map(({ wallet }, offset) =>
      funder.sendTransaction({
        to: wallet.address,
        value: fundAmount,
        nonce: nonce + offset,
        gasPrice,
      }),
    ),
  );
  const fundingReceipts = await Promise.all(fundingTxs.map((tx) => tx.wait(MIN_CONFIRMATIONS)));
  for (let i = 0; i < wallets.length; i++) {
    report.funding.push({
      index: wallets[i].index,
      address: wallets[i].wallet.address,
      amountEth: ethers.formatEther(fundAmount),
      tx: fundingReceipts[i].hash,
      blockNumber: fundingReceipts[i].blockNumber,
    });
  }
  writeJson(outPath, report);
  writeJson(secretsPathFor(outPath), secrets);

  const commitStatus = await waitFor(provider, game, (status) => status.inCommit, "commit");
  const epoch = commitStatus.epoch;
  report.epoch = epoch.toString();
  for (const entry of wallets) {
    const commitment = makeCommitment(entry.wallet.address, epoch, entry.secretHash);
    entry.commitment = commitment;
    const walletReport = report.wallets.find((wallet) => wallet.address === entry.wallet.address);
    walletReport.commitment = commitment;
  }
  console.log(JSON.stringify({ step: "commit", epoch: epoch.toString(), blockNumber: commitStatus.blockNumber.toString() }, null, 2));
  const commitReceipts = await mapLimit(wallets, count, async (entry) => {
    const tx = await game.connect(entry.wallet.connect(provider)).commitMint(entry.commitment, { gasLimit: COMMIT_GAS_LIMIT, gasPrice });
    return tx.wait(MIN_CONFIRMATIONS);
  });
  for (let i = 0; i < wallets.length; i++) {
    report.commits.push({
      index: wallets[i].index,
      address: wallets[i].wallet.address,
      commitment: wallets[i].commitment,
      tx: commitReceipts[i].hash,
      blockNumber: commitReceipts[i].blockNumber,
      gasUsed: commitReceipts[i].gasUsed.toString(),
    });
  }
  writeJson(outPath, report);

  const revealStatus = await waitFor(provider, game, (status) => status.epoch === epoch && status.inReveal, "reveal");
  console.log(JSON.stringify({ step: "reveal", epoch: epoch.toString(), blockNumber: revealStatus.blockNumber.toString() }, null, 2));
  const revealReceipts = await mapLimit(wallets, count, async (entry) => {
    const tx = await game.connect(entry.wallet.connect(provider)).revealMint(epoch, entry.secretHash, {
      gasLimit: REVEAL_GAS_LIMIT,
      gasPrice,
    });
    return tx.wait(MIN_CONFIRMATIONS);
  });
  for (let i = 0; i < wallets.length; i++) {
    report.reveals.push({
      index: wallets[i].index,
      address: wallets[i].wallet.address,
      tx: revealReceipts[i].hash,
      blockNumber: revealReceipts[i].blockNumber,
      gasUsed: revealReceipts[i].gasUsed.toString(),
    });
  }
  writeJson(outPath, report);

  const claimStatus = await waitFor(provider, game, (status) => status.blockNumber >= revealStatus.claimStart, "claim");
  console.log(JSON.stringify({ step: "claim", epoch: epoch.toString(), blockNumber: claimStatus.blockNumber.toString() }, null, 2));
  const claimReceipts = await mapLimit(wallets, count, async (entry) => {
    const tx = await game.connect(entry.wallet.connect(provider)).claimMint(epoch, { gasLimit: CLAIM_GAS_LIMIT, gasPrice });
    return tx.wait(MIN_CONFIRMATIONS);
  });
  for (let i = 0; i < wallets.length; i++) {
    const mintedEvent = claimReceipts[i].logs
      .map((log) => {
        try {
          return game.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event && event.name === "BeingMinted");
    report.claims.push({
      index: wallets[i].index,
      address: wallets[i].wallet.address,
      ok: true,
      tx: claimReceipts[i].hash,
      blockNumber: claimReceipts[i].blockNumber,
      gasUsed: claimReceipts[i].gasUsed.toString(),
      tokenId: mintedEvent ? mintedEvent.args.tokenId.toString() : null,
    });
  }

  report.completedAt = new Date().toISOString();
  report.summary = {
    wallets: count,
    epoch: epoch.toString(),
    committed: report.commits.length,
    revealed: report.reveals.length,
    claimed: report.claims.length,
    tokenIds: report.claims.map((claim) => claim.tokenId),
  };
  writeJson(outPath, report);
  console.log(JSON.stringify({ step: "done", summary: report.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
