const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-2-wallet-mint-cycle.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-2-wallet-mint-cycle.secrets.json",
  tokenIdRaw = "1",
  outputPath = "reports/sepolia-fast-v4-hunt-ore-smoke.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-hunt-ore-smoke.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [tokenId] [outputPath]",
    ].join("\n"),
  );
}

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

async function expectRevert(label, action) {
  try {
    const tx = await action();
    if (tx && typeof tx.wait === "function") await tx.wait();
    return { label, ok: false, error: "transaction unexpectedly succeeded" };
  } catch (error) {
    return { label, ok: true, error: error.shortMessage || error.reason || error.message };
  }
}

async function waitBlocks(provider, blocks) {
  const start = await provider.getBlockNumber();
  const target = start + Number(blocks);
  while ((await provider.getBlockNumber()) < target) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { start, target, end: await provider.getBlockNumber() };
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const tokenId = BigInt(tokenIdRaw);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const tokenClaim = (claimReport.claims || []).find((claim) => claim.ok && String(claim.tokenId) === String(tokenId));
  if (!tokenClaim) throw new Error(`missing claim for token ${tokenId}`);
  const otherClaim = (claimReport.claims || []).find((claim) => claim.ok && claim.address.toLowerCase() !== tokenClaim.address.toLowerCase());
  if (!otherClaim) throw new Error("missing secondary wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const oreAddress = await gameRead.ore();
  const oreRead = new ethers.Contract(oreAddress, oreArtifact.abi, provider);
  const hunter = new ethers.Wallet(secretForAddress(secrets, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secrets, otherClaim.address), provider);
  const game = gameRead.connect(hunter);
  const gameOther = gameRead.connect(other);
  const ore = oreRead.connect(hunter);
  const oreOther = oreRead.connect(other);

  const cooldown = await gameRead.cooldownUntil(tokenId);
  while (BigInt(await provider.getBlockNumber()) < cooldown) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const initial = {
    blockNumber: await provider.getBlockNumber(),
    oreAddress,
    owner: await gameRead.ownerOf(tokenId),
    totalEmitted: (await gameRead.totalEmitted()).toString(),
    emittedCap: (await gameRead.emittedCap()).toString(),
    oreTotalSupply: (await oreRead.totalSupply()).toString(),
    hunterOre: (await oreRead.balanceOf(hunter.address)).toString(),
    otherOre: (await oreRead.balanceOf(other.address)).toString(),
  };

  const negativeBefore = [
    await expectRevert("non-minter cannot mint ORE", () => oreOther.mint(other.address, 1n)),
    await expectRevert("non-owner cannot enter hunt", () => gameOther.enterHunt(tokenId)),
  ];

  const enterTx = await game.enterHunt(tokenId, { gasLimit: 280000n });
  const enterReceipt = await enterTx.wait();
  const hunt = await gameRead.hunts(tokenId);
  const ownerWhileHunting = await gameRead.ownerOf(tokenId);
  const negativeDuring = [
    await expectRevert("cannot resolve hunt in entry block", () => game.resolveHunt.staticCall(tokenId)),
    await expectRevert("NFT transfer blocked while hunting", () => game.transferFrom(hunter.address, other.address, tokenId)),
    await expectRevert("non-hunter cannot resolve hunt", () => gameOther.resolveHunt(tokenId)),
  ];

  const waited = await waitBlocks(provider, 2);
  const beforeResolve = {
    totalEmitted: await gameRead.totalEmitted(),
    oreTotalSupply: await oreRead.totalSupply(),
    hunterOre: await oreRead.balanceOf(hunter.address),
  };
  const resolveTx = await game.resolveHunt(tokenId, { gasLimit: 360000n });
  const resolveReceipt = await resolveTx.wait();
  const afterResolve = {
    totalEmitted: await gameRead.totalEmitted(),
    oreTotalSupply: await oreRead.totalSupply(),
    hunterOre: await oreRead.balanceOf(hunter.address),
    emittedCap: await gameRead.emittedCap(),
    owner: await gameRead.ownerOf(tokenId),
    being: await gameRead.getBeing(tokenId),
  };
  const reward = afterResolve.hunterOre - beforeResolve.hunterOre;

  const negativeAfter = [
    await expectRevert("cannot transfer more ORE than balance", () => ore.transfer(other.address, afterResolve.hunterOre + 1n)),
    await expectRevert("cannot transfer ORE to zero address", () => ore.transfer(ethers.ZeroAddress, 1n)),
  ];

  let transfer = null;
  if (reward > 0n) {
    const amount = reward / 2n || 1n;
    const tx = await ore.transfer(other.address, amount, { gasLimit: 90000n });
    const receipt = await tx.wait();
    transfer = {
      amount: amount.toString(),
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  const finalState = {
    totalEmitted: (await gameRead.totalEmitted()).toString(),
    emittedCap: (await gameRead.emittedCap()).toString(),
    oreTotalSupply: (await oreRead.totalSupply()).toString(),
    hunterOre: (await oreRead.balanceOf(hunter.address)).toString(),
    otherOre: (await oreRead.balanceOf(other.address)).toString(),
    owner: await gameRead.ownerOf(tokenId),
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    oreAddress,
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    other: other.address,
    initial,
    negativeBefore,
    enter: {
      tx: enterReceipt.hash,
      blockNumber: enterReceipt.blockNumber,
      gasUsed: enterReceipt.gasUsed.toString(),
      ownerWhileHunting,
      hunt: {
        owner: hunt.owner,
        startBlock: hunt.startBlock.toString(),
        sceneId: hunt.sceneId.toString(),
        difficulty: hunt.difficulty.toString(),
        endurance: hunt.endurance.toString(),
        tokenMultiplier: hunt.tokenMultiplier.toString(),
      },
    },
    negativeDuring,
    waited,
    resolve: {
      tx: resolveReceipt.hash,
      blockNumber: resolveReceipt.blockNumber,
      gasUsed: resolveReceipt.gasUsed.toString(),
      reward: reward.toString(),
      emittedDelta: (afterResolve.totalEmitted - beforeResolve.totalEmitted).toString(),
      supplyDelta: (afterResolve.oreTotalSupply - beforeResolve.oreTotalSupply).toString(),
      ownerAfterResolve: afterResolve.owner,
      being: {
        power: afterResolve.being.power.toString(),
        skill: afterResolve.being.skill.toString(),
        scars: afterResolve.being.scars.toString(),
        stage: afterResolve.being.stage.toString(),
      },
    },
    negativeAfter,
    transfer,
    finalState,
    ok:
      ownerWhileHunting.toLowerCase() === gameAddress.toLowerCase() &&
      afterResolve.owner.toLowerCase() === hunter.address.toLowerCase() &&
      reward === afterResolve.oreTotalSupply - beforeResolve.oreTotalSupply &&
      reward === afterResolve.totalEmitted - beforeResolve.totalEmitted &&
      afterResolve.oreTotalSupply <= afterResolve.emittedCap &&
      [...negativeBefore, ...negativeDuring, ...negativeAfter].every((item) => item.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
