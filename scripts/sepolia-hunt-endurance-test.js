const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  tokenIdRaw = "1",
  roundsRaw = "3",
  waitBlocksRaw = "4",
  claimReportPath = "reports/sepolia-fast-v4-2-wallet-mint-cycle.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-2-wallet-mint-cycle.secrets.json",
  outputPath = "reports/sepolia-fast-v4-hunt-endurance-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-hunt-endurance-test.js <rpcUrl> <gameAddress> [tokenId] [rounds] [waitBlocks] [claimReport] [secretsPath] [outputPath]",
      "",
      "Runs repeated Sepolia hunt/resolve cycles and checks lock, cooldown, ORE cap, and metadata updates.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function findClaimByToken(claimReport, tokenId) {
  return (claimReport.claims || []).find((claim) => claim.ok && String(claim.tokenId) === String(tokenId));
}

function secretForAddress(secretReport, address) {
  const lower = address.toLowerCase();
  const match = (secretReport.wallets || []).find((wallet) => String(wallet.address).toLowerCase() === lower);
  if (!match || !match.privateKey) throw new Error(`missing private key for ${address}`);
  return match.privateKey;
}

async function waitForBlock(provider, targetBlock) {
  let block = await provider.getBlockNumber();
  while (block < targetBlock) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    block = await provider.getBlockNumber();
  }
  return block;
}

async function waitCooldown(provider, game, tokenId) {
  const cooldown = await game.cooldownUntil(tokenId);
  const block = BigInt(await provider.getBlockNumber());
  if (block < cooldown) {
    await waitForBlock(provider, Number(cooldown));
  }
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

function expectedHuntReward(before, after, hunt, resolveBlock, baseHuntRate) {
  const elapsed = BigInt(resolveBlock) - BigInt(hunt.startBlock);
  const activeBlocks = elapsed > hunt.endurance ? hunt.endurance : elapsed;
  let reward = 0n;
  if (activeBlocks > 0n && hunt.difficulty > 0n) {
    reward = (activeBlocks * scoreOf(before.being) * baseHuntRate) / hunt.difficulty;
    reward = (reward * hunt.tokenMultiplier) / 10_000n;
    const available = after.emittedCap > before.totalEmitted ? after.emittedCap - before.totalEmitted : 0n;
    if (reward > available) reward = available;
  }
  return { elapsed, activeBlocks, reward };
}

async function metadataSnapshot(game, tokenId) {
  const tokenURI = await game.tokenURI(tokenId);
  const prefix = "data:application/json;base64,";
  if (!tokenURI.startsWith(prefix)) throw new Error("unexpected tokenURI prefix");
  const metadata = JSON.parse(Buffer.from(tokenURI.slice(prefix.length), "base64").toString("utf8"));
  return {
    tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
    name: metadata.name,
    imagePrefix: String(metadata.image || "").slice(0, 30),
    attributes: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
    traitValues: Array.isArray(metadata.attributes)
      ? Object.fromEntries(metadata.attributes.map((attr) => [attr.trait_type, String(attr.value)]))
      : {},
  };
}

function findEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {
      // Ignore logs from ORE.
    }
  }
  return null;
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const tokenId = BigInt(tokenIdRaw);
  const rounds = Number(roundsRaw);
  const waitBlocks = Number(waitBlocksRaw);
  if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error("rounds must be positive");
  if (!Number.isSafeInteger(waitBlocks) || waitBlocks <= 0) throw new Error("waitBlocks must be positive");

  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const tokenClaim = findClaimByToken(claimReport, tokenId);
  if (!tokenClaim) throw new Error(`claim report has no tokenId ${tokenId}`);
  const otherClaim = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== tokenClaim.address.toLowerCase(),
  );
  if (!otherClaim) throw new Error("claim report has no secondary wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = readJson("artifacts/EternalBeings.json");
  const oreArtifact = readJson("artifacts/EternalOre.json");
  const hunter = new ethers.Wallet(secretForAddress(secrets, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secrets, otherClaim.address), provider);
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const game = gameRead.connect(hunter);
  const gameOther = gameRead.connect(other);
  const ore = new ethers.Contract(await gameRead.ore(), oreArtifact.abi, provider);
  const baseHuntRate = await gameRead.BASE_HUNT_RATE();

  const owner = await gameRead.ownerOf(tokenId);
  const recovery = [];
  if (owner.toLowerCase() === gameAddress.toLowerCase()) {
    const hunt = await gameRead.hunts(tokenId);
    if (hunt.owner.toLowerCase() !== hunter.address.toLowerCase()) {
      throw new Error(`token is hunting under unexpected owner ${hunt.owner}`);
    }
    const tx = await game.resolveHunt(tokenId, { gasLimit: 360000n });
    const receipt = await tx.wait();
    recovery.push({ tx: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
  } else if (owner.toLowerCase() !== hunter.address.toLowerCase()) {
    throw new Error(`token ${tokenId} owner is ${owner}, expected ${hunter.address}`);
  }

  const initial = {
    blockNumber: await provider.getBlockNumber(),
    owner: await gameRead.ownerOf(tokenId),
    being: await gameRead.getBeing(tokenId),
    oreBalance: await ore.balanceOf(hunter.address),
    oreTotalSupply: await ore.totalSupply(),
    totalEmitted: await gameRead.totalEmitted(),
    emittedCap: await gameRead.emittedCap(),
    metadata: await metadataSnapshot(gameRead, tokenId),
  };

  const roundReports = [];
  for (let round = 1; round <= rounds; round++) {
    await waitCooldown(provider, gameRead, tokenId);
    const before = {
      blockNumber: await provider.getBlockNumber(),
      being: await gameRead.getBeing(tokenId),
      oreBalance: await ore.balanceOf(hunter.address),
      oreTotalSupply: await ore.totalSupply(),
      totalEmitted: await gameRead.totalEmitted(),
      emittedCap: await gameRead.emittedCap(),
      metadata: await metadataSnapshot(gameRead, tokenId),
    };

    const enterTx = await game.enterHunt(tokenId, { gasLimit: 280000n });
    const enterReceipt = await enterTx.wait();
    const hunt = await gameRead.hunts(tokenId);
    const ownerWhileHunting = await gameRead.ownerOf(tokenId);
    const negativeDuring = [
      await expectRevert("cannot resolve hunt in entry block", () => game.resolveHunt.staticCall(tokenId)),
      await expectRevert("hunter cannot transfer while hunting", () =>
        game.transferFrom(hunter.address, other.address, tokenId),
      ),
      await expectRevert("other wallet cannot resolve", () => gameOther.resolveHunt(tokenId)),
      await expectRevert("cannot enter twice", () => game.enterHunt(tokenId)),
    ];

    const sampleBlocks = [];
    const targetBlock = enterReceipt.blockNumber + waitBlocks;
    while ((await provider.getBlockNumber()) < targetBlock) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const sampleBlock = await provider.getBlockNumber();
      const sampleHunt = await gameRead.hunts(tokenId);
      sampleBlocks.push({
        blockNumber: sampleBlock,
        owner: await gameRead.ownerOf(tokenId),
        huntOwner: sampleHunt.owner,
        elapsed: (BigInt(sampleBlock) - hunt.startBlock).toString(),
      });
    }

    const resolveTx = await game.resolveHunt(tokenId, { gasLimit: 360000n });
    const resolveReceipt = await resolveTx.wait();
    const huntResolved = findEvent(gameRead, resolveReceipt, "HuntResolved");
    const metadataUpdate = findEvent(gameRead, resolveReceipt, "MetadataUpdate");
    const after = {
      blockNumber: await provider.getBlockNumber(),
      owner: await gameRead.ownerOf(tokenId),
      hunt: await gameRead.hunts(tokenId),
      cooldownUntil: await gameRead.cooldownUntil(tokenId),
      being: await gameRead.getBeing(tokenId),
      oreBalance: await ore.balanceOf(hunter.address),
      oreTotalSupply: await ore.totalSupply(),
      totalEmitted: await gameRead.totalEmitted(),
      emittedCap: await gameRead.emittedCap(),
      metadata: await metadataSnapshot(gameRead, tokenId),
    };
    const immediateCooldown = await expectRevert("immediate re-enter blocked by cooldown", () =>
      game.enterHunt.staticCall(tokenId),
    );

    const reward = after.oreBalance - before.oreBalance;
    const expected = expectedHuntReward(before, after, hunt, resolveReceipt.blockNumber, baseHuntRate);
    roundReports.push({
      round,
      before: {
        blockNumber: before.blockNumber,
        power: before.being.power.toString(),
        skill: before.being.skill.toString(),
        huntNonce: before.being.huntNonce.toString(),
        genome: before.being.genome,
        tokenURIBytes: before.metadata.tokenURIBytes,
      },
      enter: {
        tx: enterReceipt.hash,
        blockNumber: enterReceipt.blockNumber,
        gasUsed: enterReceipt.gasUsed.toString(),
        ownerWhileHunting,
        sceneId: hunt.sceneId.toString(),
        difficulty: hunt.difficulty.toString(),
        endurance: hunt.endurance.toString(),
        tokenMultiplier: hunt.tokenMultiplier.toString(),
      },
      negativeDuring,
      sampleBlocks,
      resolve: {
        tx: resolveReceipt.hash,
        blockNumber: resolveReceipt.blockNumber,
        gasUsed: resolveReceipt.gasUsed.toString(),
        reward: reward.toString(),
        expectedReward: expected.reward.toString(),
        elapsedBlocks: expected.elapsed.toString(),
        activeBlocks: expected.activeBlocks.toString(),
        emittedDelta: (after.totalEmitted - before.totalEmitted).toString(),
        supplyDelta: (after.oreTotalSupply - before.oreTotalSupply).toString(),
        eventReward: huntResolved ? huntResolved.args.reward.toString() : null,
        powerUp: huntResolved ? huntResolved.args.powerUp : null,
        skillUp: huntResolved ? huntResolved.args.skillUp : null,
        metadataUpdateTokenId: metadataUpdate ? metadataUpdate.args.tokenId.toString() : null,
      },
      after: {
        blockNumber: after.blockNumber,
        owner: after.owner,
        cooldownUntil: after.cooldownUntil.toString(),
        power: after.being.power.toString(),
        skill: after.being.skill.toString(),
        huntNonce: after.being.huntNonce.toString(),
        genome: after.being.genome,
        tokenURIBytes: after.metadata.tokenURIBytes,
        oreBalance: after.oreBalance.toString(),
        oreTotalSupply: after.oreTotalSupply.toString(),
        totalEmitted: after.totalEmitted.toString(),
        emittedCap: after.emittedCap.toString(),
      },
      immediateCooldown,
      ok:
        ownerWhileHunting.toLowerCase() === gameAddress.toLowerCase() &&
        negativeDuring.every((item) => item.ok) &&
        sampleBlocks.every(
          (sample) =>
            sample.owner.toLowerCase() === gameAddress.toLowerCase() &&
            sample.huntOwner.toLowerCase() === hunter.address.toLowerCase(),
        ) &&
        after.owner.toLowerCase() === hunter.address.toLowerCase() &&
        after.hunt.owner === ethers.ZeroAddress &&
        reward === after.totalEmitted - before.totalEmitted &&
        reward === after.oreTotalSupply - before.oreTotalSupply &&
        reward === expected.reward &&
        after.oreTotalSupply <= after.emittedCap &&
        huntResolved !== null &&
        metadataUpdate !== null &&
        immediateCooldown.ok,
    });
  }

  const finalBeing = await gameRead.getBeing(tokenId);
  const finalOreTotalSupply = await ore.totalSupply();
  const finalEmittedCap = await gameRead.emittedCap();
  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    oreAddress: await gameRead.ore(),
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    other: other.address,
    rounds,
    waitBlocks,
    recovery,
    initial: {
      blockNumber: initial.blockNumber,
      owner: initial.owner,
      power: initial.being.power.toString(),
      skill: initial.being.skill.toString(),
      huntNonce: initial.being.huntNonce.toString(),
      oreBalance: initial.oreBalance.toString(),
      oreTotalSupply: initial.oreTotalSupply.toString(),
      totalEmitted: initial.totalEmitted.toString(),
      emittedCap: initial.emittedCap.toString(),
      tokenURIBytes: initial.metadata.tokenURIBytes,
    },
    roundReports,
    final: {
      owner: await gameRead.ownerOf(tokenId),
      power: finalBeing.power.toString(),
      skill: finalBeing.skill.toString(),
      huntNonce: finalBeing.huntNonce.toString(),
      oreBalance: (await ore.balanceOf(hunter.address)).toString(),
      oreTotalSupply: finalOreTotalSupply.toString(),
      totalEmitted: (await gameRead.totalEmitted()).toString(),
      emittedCap: finalEmittedCap.toString(),
    },
    ok: roundReports.every((round) => round.ok) && finalOreTotalSupply <= finalEmittedCap,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
