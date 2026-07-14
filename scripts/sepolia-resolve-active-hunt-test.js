const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  tokenIdRaw = "1",
  minElapsedBlocksRaw = "25",
  claimReportPath = "reports/sepolia-fast-v5-2-wallet-mint-cycle-robust.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v5-2-wallet-mint-cycle-robust.secrets.json",
  outputPath = "reports/sepolia-fast-v5-active-hunt-resolve-test.json",
] = process.argv.slice(2);

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function secretForAddress(secretReport, address) {
  const lower = address.toLowerCase();
  const match = (secretReport.wallets || []).find((wallet) => String(wallet.address).toLowerCase() === lower);
  if (!match || !match.privateKey) throw new Error(`missing private key for ${address}`);
  return match.privateKey;
}

function sqrtBigInt(value) {
  if (value < 2n) return value;
  let x0 = value / 2n;
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

function scoreOf(being) {
  const value =
    sqrtBigInt(being.power) * 8n +
    sqrtBigInt(being.skill) * 5n +
    sqrtBigInt(being.complexity) / 2n +
    sqrtBigInt(being.mass);
  return sqrtBigInt(value === 0n ? 1n : value);
}

async function waitForBlock(provider, targetBlock) {
  let block = await provider.getBlockNumber();
  while (block < targetBlock) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    block = await provider.getBlockNumber();
  }
  return block;
}

async function expectRevert(label, action) {
  try {
    const tx = await action();
    if (tx && typeof tx.wait === "function") await tx.wait();
    return { label, ok: false, error: "transaction unexpectedly succeeded" };
  } catch (error) {
    return { label, ok: true, error: error.shortMessage || error.reason || error.message };
  }
}

function findEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {
      // Ignore ORE logs.
    }
  }
  return null;
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    throw new Error(
      "Usage: node scripts/sepolia-resolve-active-hunt-test.js <rpcUrl> <gameAddress> [tokenId] [minElapsedBlocks] [claimReport] [secretsPath] [outputPath]",
    );
  }

  const tokenId = BigInt(tokenIdRaw);
  const minElapsedBlocks = BigInt(minElapsedBlocksRaw);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const tokenClaim = (claimReport.claims || []).find((claim) => claim.ok && String(claim.tokenId) === String(tokenId));
  if (!tokenClaim) throw new Error(`missing claim for token ${tokenId}`);
  const otherClaim = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== tokenClaim.address.toLowerCase(),
  );
  if (!otherClaim) throw new Error("missing secondary wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = readJson("artifacts/EternalBeings.json");
  const oreArtifact = readJson("artifacts/EternalOre.json");
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const ore = new ethers.Contract(await gameRead.ore(), oreArtifact.abi, provider);
  const hunter = new ethers.Wallet(secretForAddress(secrets, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secrets, otherClaim.address), provider);
  const game = gameRead.connect(hunter);
  const gameOther = gameRead.connect(other);

  const hunt = await gameRead.hunts(tokenId);
  if (hunt.owner.toLowerCase() !== hunter.address.toLowerCase()) {
    throw new Error(`token ${tokenId} is not hunting for expected owner; hunt owner ${hunt.owner}`);
  }
  const ownerWhileHunting = await gameRead.ownerOf(tokenId);
  if (ownerWhileHunting.toLowerCase() !== gameAddress.toLowerCase()) {
    throw new Error(`token ${tokenId} is not escrowed by game; owner ${ownerWhileHunting}`);
  }

  const negativeDuring = [
    await expectRevert("non-hunter cannot resolve", () => gameOther.resolveHunt.staticCall(tokenId)),
    await expectRevert("hunter cannot transfer while hunting", () =>
      game.transferFrom.staticCall(hunter.address, other.address, tokenId),
    ),
    await expectRevert("cannot enter twice while hunting", () => game.enterHunt.staticCall(tokenId)),
  ];

  const targetBlock = Number(hunt.startBlock + minElapsedBlocks);
  const reachedBlock = await waitForBlock(provider, targetBlock);
  const before = {
    blockNumber: reachedBlock,
    being: await gameRead.getBeing(tokenId),
    oreBalance: await ore.balanceOf(hunter.address),
    oreTotalSupply: await ore.totalSupply(),
    totalEmitted: await gameRead.totalEmitted(),
  };

  const tx = await game.resolveHunt(tokenId, { gasLimit: 360000n });
  const receipt = await tx.wait();
  const after = {
    blockNumber: await provider.getBlockNumber(),
    owner: await gameRead.ownerOf(tokenId),
    hunt: await gameRead.hunts(tokenId),
    being: await gameRead.getBeing(tokenId),
    oreBalance: await ore.balanceOf(hunter.address),
    oreTotalSupply: await ore.totalSupply(),
    totalEmitted: await gameRead.totalEmitted(),
    emittedCap: await gameRead.emittedCap(),
  };

  const elapsed = BigInt(receipt.blockNumber) - hunt.startBlock;
  const activeBlocks = elapsed > hunt.endurance ? hunt.endurance : elapsed;
  let expectedReward = 0n;
  if (activeBlocks > 0n && hunt.difficulty > 0n) {
    expectedReward = (activeBlocks * scoreOf(before.being) * (await gameRead.BASE_HUNT_RATE())) / hunt.difficulty;
    expectedReward = (expectedReward * hunt.tokenMultiplier) / 10_000n;
    const available = after.emittedCap > before.totalEmitted ? after.emittedCap - before.totalEmitted : 0n;
    if (expectedReward > available) expectedReward = available;
  }
  const reward = after.oreBalance - before.oreBalance;
  const event = findEvent(gameRead, receipt, "HuntResolved");
  const metadataUpdate = findEvent(gameRead, receipt, "MetadataUpdate");

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    ownerWhileHunting,
    hunt: {
      startBlock: hunt.startBlock.toString(),
      endurance: hunt.endurance.toString(),
      difficulty: hunt.difficulty.toString(),
      sceneId: hunt.sceneId.toString(),
      tokenMultiplier: hunt.tokenMultiplier.toString(),
    },
    negativeDuring,
    wait: {
      minElapsedBlocks: minElapsedBlocks.toString(),
      targetBlock: String(targetBlock),
      reachedBlock: String(reachedBlock),
      resolveBlock: String(receipt.blockNumber),
      elapsed: elapsed.toString(),
      activeBlocks: activeBlocks.toString(),
    },
    resolve: {
      tx: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      reward: reward.toString(),
      expectedReward: expectedReward.toString(),
      emittedDelta: (after.totalEmitted - before.totalEmitted).toString(),
      supplyDelta: (after.oreTotalSupply - before.oreTotalSupply).toString(),
      eventReward: event ? event.args.reward.toString() : null,
      metadataUpdateTokenId: metadataUpdate ? metadataUpdate.args.tokenId.toString() : null,
    },
    after: {
      owner: after.owner,
      huntOwner: after.hunt.owner,
      power: after.being.power.toString(),
      skill: after.being.skill.toString(),
      oreTotalSupply: after.oreTotalSupply.toString(),
      totalEmitted: after.totalEmitted.toString(),
      emittedCap: after.emittedCap.toString(),
    },
    ok:
      negativeDuring.every((item) => item.ok) &&
      after.owner.toLowerCase() === hunter.address.toLowerCase() &&
      after.hunt.owner === ethers.ZeroAddress &&
      reward === expectedReward &&
      reward === after.totalEmitted - before.totalEmitted &&
      reward === after.oreTotalSupply - before.oreTotalSupply &&
      after.oreTotalSupply <= after.emittedCap &&
      event !== null &&
      metadataUpdate !== null,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
