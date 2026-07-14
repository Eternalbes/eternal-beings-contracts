const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  reportPath,
  mintSecretPath,
  funderSecretPath,
  topupEth = "0.006",
] = process.argv.slice(2);

const REVEAL_GAS_LIMIT = 220000n;
const CLAIM_GAS_LIMIT = 500000n;

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-mint-cycle-resume.js <rpcUrl> <gameAddress> <reportPath> <mintSecretPath> <funderSecretPath> [topupEth]",
      "",
      "Resumes a partially completed Sepolia mint cycle without printing private keys.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function privateKeyFor(secretReport, address) {
  const lower = address.toLowerCase();
  const wallet = (secretReport.wallets || []).find((entry) => String(entry.address).toLowerCase() === lower);
  if (!wallet || !wallet.privateKey) throw new Error(`missing private key for ${address}`);
  return wallet.privateKey;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fee(provider, multiplier = 3n) {
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

async function mintPhase(provider, game, epoch) {
  const [blockRaw, commitBlocks, epochBlocks] = await Promise.all([
    provider.getBlockNumber(),
    game.COMMIT_BLOCKS(),
    game.EPOCH_BLOCKS(),
  ]);
  const block = BigInt(blockRaw);
  const start = await game.epochStart(epoch);
  return {
    block,
    start,
    revealStart: start + commitBlocks,
    claimStart: start + epochBlocks,
    inReveal: block >= start + commitBlocks && block < start + epochBlocks,
    inClaim: block >= start + epochBlocks,
    expired: (await game.currentEpoch()) > epoch,
  };
}

async function waitFor(provider, game, epoch, predicate, label) {
  for (;;) {
    const phase = await mintPhase(provider, game, epoch);
    if (phase.expired && !predicate(phase)) throw new Error(`${label} window expired for epoch ${epoch}`);
    if (predicate(phase)) return phase;
    console.log(JSON.stringify({ step: "wait", label, blockNumber: phase.block.toString(), epoch: epoch.toString() }));
    await sleep(2500);
  }
}

async function main() {
  if (!rpcUrl || !gameAddress || !reportPath || !mintSecretPath || !funderSecretPath) {
    usage();
    process.exit(1);
  }

  const report = readJson(reportPath);
  const mintSecrets = readJson(mintSecretPath);
  const funderSecrets = readJson(funderSecretPath);
  const artifact = readJson("artifacts/EternalBeings.json");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const epoch = BigInt(report.epoch);
  const funder = new ethers.Wallet(privateKeyFor(funderSecrets, report.funder), provider);
  const topupWei = ethers.parseEther(topupEth);

  report.resumedAt = report.resumedAt || new Date().toISOString();
  report.topups = report.topups || [];
  report.reveals = report.reveals || [];
  report.claims = report.claims || [];

  const fundingFee = await fee(provider, 3n);
  let nonce = await provider.getTransactionCount(funder.address, "pending");
  for (const publicWallet of report.wallets || []) {
    const balance = await provider.getBalance(publicWallet.address);
    if (balance >= ethers.parseEther("0.004")) continue;
    const tx = await funder.sendTransaction({ to: publicWallet.address, value: topupWei, nonce, ...fundingFee });
    nonce += 1;
    const receipt = await tx.wait(1);
    report.topups.push({
      index: publicWallet.index,
      address: publicWallet.address,
      amountEth: topupEth,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    writeJson(reportPath, report);
  }

  await waitFor(provider, gameRead, epoch, (phase) => phase.inReveal || phase.inClaim, "reveal");
  const revealFee = await fee(provider, 3n);
  for (const publicWallet of report.wallets || []) {
    if (report.reveals.some((entry) => entry.index === publicWallet.index)) continue;
    const secret = mintSecrets.wallets.find((entry) => entry.index === publicWallet.index);
    if (!secret) throw new Error(`missing mint secret for index ${publicWallet.index}`);
    const wallet = new ethers.Wallet(secret.privateKey, provider);
    const game = gameRead.connect(wallet);
    const revealed = await game.revealed(epoch, wallet.address);
    if (!revealed) {
      await game.revealMint.staticCall(epoch, secret.secretHash);
      const tx = await game.revealMint(epoch, secret.secretHash, { gasLimit: REVEAL_GAS_LIMIT, ...revealFee });
      const receipt = await tx.wait(1);
      report.reveals.push({
        index: publicWallet.index,
        address: wallet.address,
        tx: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      });
      writeJson(reportPath, report);
    }
  }

  await waitFor(provider, gameRead, epoch, (phase) => phase.inClaim, "claim");
  const claimFee = await fee(provider, 3n);
  for (const publicWallet of report.wallets || []) {
    if (report.claims.some((entry) => entry.index === publicWallet.index)) continue;
    const secret = mintSecrets.wallets.find((entry) => entry.index === publicWallet.index);
    const wallet = new ethers.Wallet(secret.privateKey, provider);
    const game = gameRead.connect(wallet);
    const claimed = await game.claimedEpoch(epoch, wallet.address);
    if (!claimed) {
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
        index: publicWallet.index,
        address: wallet.address,
        ok: true,
        tx: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        tokenId: mintedEvent ? mintedEvent.args.tokenId.toString() : null,
      });
      writeJson(reportPath, report);
    }
  }

  report.completedAt = new Date().toISOString();
  report.summary = {
    wallets: (report.wallets || []).length,
    epoch: epoch.toString(),
    committed: (report.commits || []).length,
    revealed: report.reveals.length,
    claimed: report.claims.length,
    tokenIds: report.claims.map((claim) => claim.tokenId),
  };
  writeJson(reportPath, report);
  console.log(JSON.stringify({ step: "done", summary: report.summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
