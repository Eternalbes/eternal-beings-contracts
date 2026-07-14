const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  tokenIdRaw = "1",
  waitBlocksRaw = "12",
  claimReportPath = "reports/sepolia-fast-v3-5-wallet-mint.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v3-5-wallet-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v3-long-hunt-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-long-hunt-test.js <rpcUrl> <gameAddress> [tokenId] [waitBlocks] [claimReport] [secretsPath] [outputPath]",
      "",
      "Enters hunt, leaves the NFT locked for multiple blocks, checks lock state, then resolves.",
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

async function expectRevert(label, action) {
  try {
    const tx = await action();
    if (tx && typeof tx.wait === "function") await tx.wait();
    return { label, ok: false, error: "transaction unexpectedly succeeded" };
  } catch (error) {
    return {
      label,
      ok: true,
      error: error.shortMessage || error.reason || error.message,
    };
  }
}

async function waitNextBlock(provider, previousBlock) {
  let block = await provider.getBlockNumber();
  while (block <= previousBlock) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    block = await provider.getBlockNumber();
  }
  return block;
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json") || !fs.existsSync("artifacts/EternalOre.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const tokenId = BigInt(tokenIdRaw);
  const waitBlocks = Number(waitBlocksRaw);
  if (!Number.isSafeInteger(waitBlocks) || waitBlocks <= 0) throw new Error("waitBlocks must be a positive integer");

  const claimReport = readJson(claimReportPath);
  const secretReport = readJson(secretsPath);
  const tokenClaim = findClaimByToken(claimReport, tokenId);
  if (!tokenClaim) throw new Error(`claim report has no tokenId ${tokenId}`);

  const otherClaim = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== tokenClaim.address.toLowerCase(),
  );
  if (!otherClaim) throw new Error("claim report has no secondary wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const hunter = new ethers.Wallet(secretForAddress(secretReport, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secretReport, otherClaim.address), provider);
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const game = gameRead.connect(hunter);
  const gameOther = gameRead.connect(other);
  const oreRead = new ethers.Contract(await gameRead.ore(), oreArtifact.abi, provider);

  const initialOwner = await gameRead.ownerOf(tokenId);
  const recovery = [];
  if (initialOwner.toLowerCase() === gameAddress.toLowerCase()) {
    const existing = await gameRead.hunts(tokenId);
    if (existing.owner.toLowerCase() !== hunter.address.toLowerCase()) {
      throw new Error(`token is hunting under unexpected owner ${existing.owner}`);
    }
    const tx = await game.resolveHunt(tokenId, { gasLimit: 340000n });
    const receipt = await tx.wait();
    recovery.push({
      action: "resolved pre-existing hunt before long-hunt test",
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  } else if (initialOwner.toLowerCase() !== hunter.address.toLowerCase()) {
    throw new Error(`token ${tokenId} owner is ${initialOwner}, expected ${hunter.address}`);
  }

  const beforeBalance = await oreRead.balanceOf(hunter.address);
  const enterTx = await game.enterHunt(tokenId, { gasLimit: 280000n });
  const enterReceipt = await enterTx.wait();
  const hunt = await gameRead.hunts(tokenId);
  const enteredOwner = await gameRead.ownerOf(tokenId);

  const negativeAtStart = [
    await expectRevert("hunter cannot transfer while hunting", () =>
      game.transferFrom(hunter.address, other.address, tokenId),
    ),
    await expectRevert("other wallet cannot resolve hunter's hunt", () => gameOther.resolveHunt(tokenId)),
  ];

  const samples = [];
  let lastBlock = enterReceipt.blockNumber;
  for (let i = 0; i < waitBlocks; i++) {
    lastBlock = await waitNextBlock(provider, lastBlock);
    const currentHunt = await gameRead.hunts(tokenId);
    samples.push({
      index: i + 1,
      blockNumber: lastBlock,
      owner: await gameRead.ownerOf(tokenId),
      huntOwner: currentHunt.owner,
      elapsedBlocks: (BigInt(lastBlock) - hunt.startBlock).toString(),
      endurance: currentHunt.endurance.toString(),
      stillHunting: currentHunt.owner !== ethers.ZeroAddress,
    });
  }

  const negativeBeforeResolve = [
    await expectRevert("other wallet still cannot transfer locked NFT", () =>
      gameOther.transferFrom(gameAddress, other.address, tokenId),
    ),
    await expectRevert("other wallet still cannot resolve", () => gameOther.resolveHunt(tokenId)),
  ];

  const resolveTx = await game.resolveHunt(tokenId, { gasLimit: 340000n });
  const resolveReceipt = await resolveTx.wait();
  const afterBalance = await oreRead.balanceOf(hunter.address);
  const finalOwner = await gameRead.ownerOf(tokenId);
  const finalHunt = await gameRead.hunts(tokenId);
  const activeBlocks =
    BigInt(resolveReceipt.blockNumber) - hunt.startBlock > hunt.endurance
      ? hunt.endurance
      : BigInt(resolveReceipt.blockNumber) - hunt.startBlock;

  let rewardEvent = null;
  for (const log of resolveReceipt.logs) {
    try {
      const parsed = gameRead.interface.parseLog(log);
      if (parsed && parsed.name === "HuntResolved") {
        rewardEvent = {
          reward: parsed.args.reward.toString(),
          powerUp: parsed.args.powerUp,
          skillUp: parsed.args.skillUp,
        };
      }
    } catch (_) {
      // Ignore ORE logs.
    }
  }

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    waitBlocks,
    recovery,
    enter: {
      tx: enterReceipt.hash,
      blockNumber: enterReceipt.blockNumber,
      gasUsed: enterReceipt.gasUsed.toString(),
    },
    hunt: {
      ownerAfterEnter: enteredOwner,
      sceneId: hunt.sceneId.toString(),
      difficulty: hunt.difficulty.toString(),
      endurance: hunt.endurance.toString(),
      tokenMultiplier: hunt.tokenMultiplier.toString(),
      startBlock: hunt.startBlock.toString(),
    },
    negativeAtStart,
    samples,
    negativeBeforeResolve,
    resolve: {
      tx: resolveReceipt.hash,
      blockNumber: resolveReceipt.blockNumber,
      gasUsed: resolveReceipt.gasUsed.toString(),
      activeBlocks: activeBlocks.toString(),
      reward: (afterBalance - beforeBalance).toString(),
      rewardEvent,
    },
    final: {
      owner: finalOwner,
      huntOwner: finalHunt.owner,
      oreBalance: afterBalance.toString(),
      totalEmitted: (await gameRead.totalEmitted()).toString(),
      oreTotalSupply: (await oreRead.totalSupply()).toString(),
      emittedCap: (await gameRead.emittedCap()).toString(),
    },
    ok:
      enteredOwner.toLowerCase() === gameAddress.toLowerCase() &&
      samples.every(
        (sample) =>
          sample.owner.toLowerCase() === gameAddress.toLowerCase() &&
          sample.huntOwner.toLowerCase() === hunter.address.toLowerCase() &&
          sample.stillHunting,
      ) &&
      negativeAtStart.every((item) => item.ok) &&
      negativeBeforeResolve.every((item) => item.ok) &&
      finalOwner.toLowerCase() === hunter.address.toLowerCase() &&
      finalHunt.owner === ethers.ZeroAddress &&
      (await oreRead.totalSupply()) <= (await gameRead.emittedCap()),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
