const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  countRaw = "2",
  outPath = "reports/sepolia-fast-v5-2-wallet-mint-cycle.json",
] = process.argv.slice(2);
const funderKey = process.env.PRIVATE_KEY || "";

const COMMIT_GAS_LIMIT = 80000n;
const REVEAL_GAS_LIMIT = 220000n;
const CLAIM_GAS_LIMIT = 500000n;
const WALLET_FUND_ETH = process.env.MINT_WALLET_FUND_ETH || "0.01";

function usage() {
  console.error(
    [
      "Usage:",
      "  PRIVATE_KEY=... node scripts/sepolia-fast-mint-cycle-robust.js <rpcUrl> <gameAddress> [count] [outPath]",
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

async function fee(provider, multiplier = 4n) {
  const feeData = await provider.getFeeData();
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: feeData.maxFeePerGas * multiplier,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * multiplier,
    };
  }
  if (!feeData.gasPrice) throw new Error("missing fee data");
  return { gasPrice: feeData.gasPrice * multiplier };
}

async function status(provider, game) {
  const [blockRaw, epoch, commitBlocks, epochBlocks] = await Promise.all([
    provider.getBlockNumber(),
    game.currentEpoch(),
    game.COMMIT_BLOCKS(),
    game.EPOCH_BLOCKS(),
  ]);
  const block = BigInt(blockRaw);
  const start = await game.epochStart(epoch);
  return {
    block,
    epoch,
    start,
    revealStart: start + commitBlocks,
    claimStart: start + epochBlocks,
    inCommit: block >= start && block < start + commitBlocks,
    inReveal: block >= start + commitBlocks && block < start + epochBlocks,
    inClaim: block >= start + epochBlocks,
  };
}

async function waitFor(provider, game, predicate, label) {
  for (;;) {
    const s = await status(provider, game);
    if (predicate(s)) return s;
    console.log(JSON.stringify({ step: "wait", label, blockNumber: s.block.toString(), epoch: s.epoch.toString() }));
    await sleep(2500);
  }
}

async function main() {
  const count = Number(countRaw);
  if (!rpcUrl || !gameAddress || !count || !funderKey) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderKey, provider);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
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
  writeJson(outPath, report);
  writeJson(secretsPathFor(outPath), secrets);

  const fundingFee = await fee(provider, 3n);
  const maxCost = ethers.parseEther(WALLET_FUND_ETH);
  let nonce = await provider.getTransactionCount(funder.address, "pending");
  for (const entry of wallets) {
    const tx = await funder.sendTransaction({ to: entry.wallet.address, value: maxCost, nonce, ...fundingFee });
    nonce += 1;
    const receipt = await tx.wait(1);
    report.funding.push({
      index: entry.index,
      address: entry.wallet.address,
      amountEth: ethers.formatEther(maxCost),
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    writeJson(outPath, report);
  }

  const commitStatus = await waitFor(provider, gameRead, (s) => s.inCommit && s.block <= s.start + 1n, "early-commit");
  const epoch = commitStatus.epoch;
  report.epoch = epoch.toString();
  for (const entry of wallets) {
    entry.commitment = makeCommitment(entry.wallet.address, epoch, entry.secretHash);
    report.wallets[entry.index].commitment = entry.commitment;
  }
  writeJson(outPath, report);

  console.log(JSON.stringify({ step: "commit", epoch: epoch.toString(), blockNumber: commitStatus.block.toString() }, null, 2));
  const commitFee = await fee(provider, 8n);
  for (const entry of wallets) {
    const game = gameRead.connect(entry.wallet.connect(provider));
    const tx = await game.commitMint(entry.commitment, { gasLimit: COMMIT_GAS_LIMIT, ...commitFee });
    const receipt = await tx.wait(1);
    report.commits.push({
      index: entry.index,
      address: entry.wallet.address,
      commitment: entry.commitment,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
    writeJson(outPath, report);
  }

  const revealStatus = await waitFor(provider, gameRead, (s) => s.epoch === epoch && s.inReveal, "reveal");
  console.log(JSON.stringify({ step: "reveal", epoch: epoch.toString(), blockNumber: revealStatus.block.toString() }, null, 2));
  const revealFee = await fee(provider, 5n);
  for (const entry of wallets) {
    const game = gameRead.connect(entry.wallet.connect(provider));
    await game.revealMint.staticCall(epoch, entry.secretHash);
    const tx = await game.revealMint(epoch, entry.secretHash, { gasLimit: REVEAL_GAS_LIMIT, ...revealFee });
    const receipt = await tx.wait(1);
    report.reveals.push({
      index: entry.index,
      address: entry.wallet.address,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
    writeJson(outPath, report);
  }

  const claimStatus = await waitFor(provider, gameRead, (s) => s.block >= revealStatus.claimStart, "claim");
  console.log(JSON.stringify({ step: "claim", epoch: epoch.toString(), blockNumber: claimStatus.block.toString() }, null, 2));
  const claimFee = await fee(provider, 4n);
  for (const entry of wallets) {
    const game = gameRead.connect(entry.wallet.connect(provider));
    await game.claimMint.staticCall(epoch);
    const tx = await game.claimMint(epoch, { gasLimit: CLAIM_GAS_LIMIT, ...claimFee });
    const receipt = await tx.wait(1);
    const mintedEvent = receipt.logs
      .map((log) => {
        try {
          return gameRead.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event && event.name === "BeingMinted");
    report.claims.push({
      index: entry.index,
      address: entry.wallet.address,
      ok: true,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      tokenId: mintedEvent ? mintedEvent.args.tokenId.toString() : null,
    });
    writeJson(outPath, report);
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
