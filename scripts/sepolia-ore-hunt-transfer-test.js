const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v3-5-wallet-mint.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v3-5-wallet-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v3-ore-hunt-transfer-test.json",
] = process.argv.slice(2);

const SKIP_HUNTS = process.env.ORE_TEST_SKIP_HUNTS === "1";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-ore-hunt-transfer-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [outputPath]",
      "",
      "Runs ORE transfer/allowance checks plus several hunt reward cycles on Sepolia.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function asString(value) {
  return typeof value === "bigint" ? value.toString() : String(value);
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

async function waitForBlocks(provider, targetBlocks) {
  const start = await provider.getBlockNumber();
  const target = start + Number(targetBlocks);
  while ((await provider.getBlockNumber()) < target) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { start, target, end: await provider.getBlockNumber() };
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

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json") || !fs.existsSync("artifacts/EternalOre.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const claimReport = readJson(claimReportPath);
  const secretReport = readJson(secretsPath);
  const tokenId = 1n;
  const tokenOneClaim = findClaimByToken(claimReport, tokenId);
  if (!tokenOneClaim) throw new Error("claim report has no tokenId 1");

  const recipientClaim = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== tokenOneClaim.address.toLowerCase(),
  );
  if (!recipientClaim) throw new Error("claim report has no recipient wallet");

  const spenderClaim = (claimReport.claims || []).find(
    (claim) =>
      claim.ok &&
      claim.address.toLowerCase() !== tokenOneClaim.address.toLowerCase() &&
      claim.address.toLowerCase() !== recipientClaim.address.toLowerCase(),
  );
  if (!spenderClaim) throw new Error("claim report has no spender wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const oreAddress = await gameRead.ore();
  const oreRead = new ethers.Contract(oreAddress, oreArtifact.abi, provider);

  const hunter = new ethers.Wallet(secretForAddress(secretReport, tokenOneClaim.address), provider);
  const recipient = new ethers.Wallet(secretForAddress(secretReport, recipientClaim.address), provider);
  const spender = new ethers.Wallet(secretForAddress(secretReport, spenderClaim.address), provider);
  const game = gameRead.connect(hunter);
  const ore = oreRead.connect(hunter);
  const oreAsSpender = oreRead.connect(spender);
  const gameAsSpender = gameRead.connect(spender);

  const recovery = [];
  const ownerBefore = await gameRead.ownerOf(tokenId);
  if (ownerBefore.toLowerCase() !== hunter.address.toLowerCase()) {
    const existingHunt = await gameRead.hunts(tokenId);
    if (
      ownerBefore.toLowerCase() === gameAddress.toLowerCase() &&
      existingHunt.owner.toLowerCase() === hunter.address.toLowerCase()
    ) {
      const beforeBalance = await oreRead.balanceOf(hunter.address);
      const tx = await game.resolveHunt(tokenId, { gasLimit: 340000n });
      const receipt = await tx.wait();
      const afterBalance = await oreRead.balanceOf(hunter.address);
      recovery.push({
        action: "resolved pre-existing hunt",
        tx: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        reward: (afterBalance - beforeBalance).toString(),
      });
      const ownerAfterRecovery = await gameRead.ownerOf(tokenId);
      if (ownerAfterRecovery.toLowerCase() !== hunter.address.toLowerCase()) {
        throw new Error(`token ${tokenId} recovery failed, owner is ${ownerAfterRecovery}`);
      }
    } else {
      throw new Error(`token ${tokenId} owner is ${ownerBefore}, expected ${hunter.address}`);
    }
  }

  const initial = {
    blockNumber: await provider.getBlockNumber(),
    oreAddress,
    tokenMaxSupply: asString(await gameRead.TOKEN_MAX_SUPPLY()),
    emittedCap: asString(await gameRead.emittedCap()),
    availableEmission: asString(await gameRead.availableEmission()),
    totalEmitted: asString(await gameRead.totalEmitted()),
    oreTotalSupply: asString(await oreRead.totalSupply()),
    hunterBalance: asString(await oreRead.balanceOf(hunter.address)),
    recipientBalance: asString(await oreRead.balanceOf(recipient.address)),
  };

  const negative = [];
  negative.push(await expectRevert("non-minter cannot mint ORE", () => ore.mint(hunter.address, 1n)));
  negative.push(await expectRevert("cannot transfer more ORE than balance", async () => {
    const balance = await oreRead.balanceOf(hunter.address);
    return ore.transfer(recipient.address, balance + 1n);
  }));
  negative.push(await expectRevert("cannot transfer ORE to zero address", () => ore.transfer(ethers.ZeroAddress, 1n)));
  negative.push(await expectRevert("cannot transferFrom without allowance", () =>
    oreAsSpender.transferFrom(hunter.address, spender.address, 1n),
  ));
  negative.push(await expectRevert("non-owner cannot enter hunt", () => gameAsSpender.enterHunt(tokenId)));

  const cycles = [];
  for (const targetBlocks of SKIP_HUNTS ? [] : [1, 2, 3]) {
    const owner = await gameRead.ownerOf(tokenId);
    if (owner.toLowerCase() !== hunter.address.toLowerCase()) {
      throw new Error(`token ${tokenId} owner changed before hunt: ${owner}`);
    }

    const enterTx = await game.enterHunt(tokenId, { gasLimit: 260000n });
    const enterReceipt = await enterTx.wait();
    const hunt = await gameRead.hunts(tokenId);

    const transferWhileHunting = await expectRevert("NFT transfer is blocked while hunting", () =>
      game.transferFrom(hunter.address, recipient.address, tokenId),
    );
    const nonHunterResolve = await expectRevert("non-hunter cannot resolve", () => gameAsSpender.resolveHunt(tokenId));

    const waited = await waitForBlocks(provider, targetBlocks);
    const beforeBalance = await oreRead.balanceOf(hunter.address);
    const beforeSupply = await oreRead.totalSupply();
    const beforeEmitted = await gameRead.totalEmitted();
    const beforeCap = await gameRead.emittedCap();

    const resolveTx = await game.resolveHunt(tokenId, { gasLimit: 320000n });
    const resolveReceipt = await resolveTx.wait();
    const afterBalance = await oreRead.balanceOf(hunter.address);
    const afterSupply = await oreRead.totalSupply();
    const afterEmitted = await gameRead.totalEmitted();
    const afterCap = await gameRead.emittedCap();
    const being = await gameRead.getBeing(tokenId);

    let resolvedEvent = null;
    for (const log of resolveReceipt.logs) {
      try {
        const parsed = gameRead.interface.parseLog(log);
        if (parsed && parsed.name === "HuntResolved") {
          resolvedEvent = {
            reward: parsed.args.reward.toString(),
            powerUp: parsed.args.powerUp,
            skillUp: parsed.args.skillUp,
          };
        }
      } catch (_) {
        // Ignore logs from the ORE contract.
      }
    }

    const rewardDelta = afterBalance - beforeBalance;
    const activeBlocks = BigInt(resolveReceipt.blockNumber) - hunt.startBlock;
    const cappedActiveBlocks = activeBlocks > hunt.endurance ? hunt.endurance : activeBlocks;
    cycles.push({
      targetWaitBlocks: String(targetBlocks),
      enter: {
        tx: enterReceipt.hash,
        blockNumber: enterReceipt.blockNumber,
        gasUsed: enterReceipt.gasUsed.toString(),
      },
      hunt: {
        sceneId: hunt.sceneId.toString(),
        difficulty: hunt.difficulty.toString(),
        endurance: hunt.endurance.toString(),
        tokenMultiplier: hunt.tokenMultiplier.toString(),
        powerRate: hunt.powerRate.toString(),
        skillRate: hunt.skillRate.toString(),
      },
      waited,
      resolve: {
        tx: resolveReceipt.hash,
        blockNumber: resolveReceipt.blockNumber,
        gasUsed: resolveReceipt.gasUsed.toString(),
      },
      activeBlocks: cappedActiveBlocks.toString(),
      reward: rewardDelta.toString(),
      rewardEvent: resolvedEvent,
      supplyDelta: (afterSupply - beforeSupply).toString(),
      emittedDelta: (afterEmitted - beforeEmitted).toString(),
      rewardEqualsSupplyAndEmittedDelta: rewardDelta === afterSupply - beforeSupply && rewardDelta === afterEmitted - beforeEmitted,
      supplyWithinCapBefore: beforeSupply <= beforeCap,
      supplyWithinCapAfter: afterSupply <= afterCap,
      afterCap: afterCap.toString(),
      being: {
        power: being.power.toString(),
        skill: being.skill.toString(),
        scars: being.scars.toString(),
        stage: being.stage.toString(),
      },
      negative: [transferWhileHunting, nonHunterResolve],
    });

    const cooldown = await gameRead.cooldownUntil(tokenId);
    while (BigInt(await provider.getBlockNumber()) < cooldown) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  const balanceForTransfers = await oreRead.balanceOf(hunter.address);
  const transferAmount = balanceForTransfers / 4n > 0n ? balanceForTransfers / 4n : 1n;
  const approveAmount = balanceForTransfers / 8n > 0n ? balanceForTransfers / 8n : 1n;

  const beforeTransferHunter = await oreRead.balanceOf(hunter.address);
  const beforeTransferRecipient = await oreRead.balanceOf(recipient.address);
  const transferTx = await ore.transfer(recipient.address, transferAmount, { gasLimit: 80000n });
  const transferReceipt = await transferTx.wait();
  const afterTransferHunter = await oreRead.balanceOf(hunter.address);
  const afterTransferRecipient = await oreRead.balanceOf(recipient.address);

  const approveTx = await ore.approve(spender.address, approveAmount, { gasLimit: 80000n });
  const approveReceipt = await approveTx.wait();
  const allowanceAfterApprove = await oreRead.allowance(hunter.address, spender.address);
  const overAllowance = await expectRevert("cannot transferFrom more than allowance", () =>
    oreAsSpender.transferFrom(hunter.address, recipient.address, approveAmount + 1n),
  );
  const beforeTransferFromRecipient = await oreRead.balanceOf(recipient.address);
  const transferFromTx = await oreAsSpender.transferFrom(hunter.address, recipient.address, approveAmount, {
    gasLimit: 90000n,
  });
  const transferFromReceipt = await transferFromTx.wait();
  const allowanceAfterTransferFrom = await oreRead.allowance(hunter.address, spender.address);
  const afterTransferFromRecipient = await oreRead.balanceOf(recipient.address);
  const approveOverwriteA = await ore.approve(spender.address, 7n, { gasLimit: 80000n });
  await approveOverwriteA.wait();
  const approveOverwriteB = await ore.approve(spender.address, 3n, { gasLimit: 80000n });
  const approveOverwriteReceipt = await approveOverwriteB.wait();
  const allowanceAfterOverwrite = await oreRead.allowance(hunter.address, spender.address);
  const zeroTransferFrom = await expectRevert("cannot transferFrom to zero address", () =>
    oreAsSpender.transferFrom(hunter.address, ethers.ZeroAddress, 1n),
  );
  const unlimitedApproveTx = await ore.approve(spender.address, ethers.MaxUint256, { gasLimit: 80000n });
  const unlimitedApproveReceipt = await unlimitedApproveTx.wait();
  const hunterBeforeUnlimited = await oreRead.balanceOf(hunter.address);
  const spenderBeforeUnlimited = await oreRead.balanceOf(spender.address);
  const unlimitedTransferTx = await oreAsSpender.transferFrom(hunter.address, spender.address, 1n, {
    gasLimit: 90000n,
  });
  const unlimitedTransferReceipt = await unlimitedTransferTx.wait();
  const allowanceAfterUnlimitedTransfer = await oreRead.allowance(hunter.address, spender.address);
  const hunterAfterUnlimited = await oreRead.balanceOf(hunter.address);
  const spenderAfterUnlimited = await oreRead.balanceOf(spender.address);
  const overBalanceWithAllowance = await expectRevert("allowance cannot bypass owner balance", () =>
    oreAsSpender.transferFrom(hunter.address, spender.address, hunterAfterUnlimited + 1n),
  );

  const final = {
    blockNumber: await provider.getBlockNumber(),
    emittedCap: asString(await gameRead.emittedCap()),
    availableEmission: asString(await gameRead.availableEmission()),
    totalEmitted: asString(await gameRead.totalEmitted()),
    oreTotalSupply: asString(await oreRead.totalSupply()),
    hunterBalance: asString(await oreRead.balanceOf(hunter.address)),
    recipientBalance: asString(await oreRead.balanceOf(recipient.address)),
    supplyWithinCap: (await oreRead.totalSupply()) <= (await gameRead.emittedCap()),
    supplyWithinMax: (await oreRead.totalSupply()) <= (await gameRead.TOKEN_MAX_SUPPLY()),
  };

  const transferChecks = {
    transfer: {
      amount: transferAmount.toString(),
      tx: transferReceipt.hash,
      blockNumber: transferReceipt.blockNumber,
      gasUsed: transferReceipt.gasUsed.toString(),
      hunterDelta: (afterTransferHunter - beforeTransferHunter).toString(),
      recipientDelta: (afterTransferRecipient - beforeTransferRecipient).toString(),
      ok:
        beforeTransferHunter - afterTransferHunter === transferAmount &&
        afterTransferRecipient - beforeTransferRecipient === transferAmount,
    },
    approveAndTransferFrom: {
      amount: approveAmount.toString(),
      approveTx: approveReceipt.hash,
      transferFromTx: transferFromReceipt.hash,
      allowanceAfterApprove: allowanceAfterApprove.toString(),
      allowanceAfterTransferFrom: allowanceAfterTransferFrom.toString(),
      recipientDelta: (afterTransferFromRecipient - beforeTransferFromRecipient).toString(),
      negative: [overAllowance],
      ok:
        overAllowance.ok &&
        allowanceAfterApprove === approveAmount &&
        allowanceAfterTransferFrom === 0n &&
        afterTransferFromRecipient - beforeTransferFromRecipient === approveAmount,
    },
    approveOverwrite: {
      approveTx: approveOverwriteReceipt.hash,
      allowanceAfterOverwrite: allowanceAfterOverwrite.toString(),
      negative: [zeroTransferFrom],
      ok: zeroTransferFrom.ok && allowanceAfterOverwrite === 3n,
    },
    unlimitedAllowance: {
      approveTx: unlimitedApproveReceipt.hash,
      transferFromTx: unlimitedTransferReceipt.hash,
      allowanceAfterTransfer: allowanceAfterUnlimitedTransfer.toString(),
      hunterDelta: (hunterAfterUnlimited - hunterBeforeUnlimited).toString(),
      spenderDelta: (spenderAfterUnlimited - spenderBeforeUnlimited).toString(),
      negative: [overBalanceWithAllowance],
      ok:
        overBalanceWithAllowance.ok &&
        allowanceAfterUnlimitedTransfer === ethers.MaxUint256 &&
        hunterBeforeUnlimited - hunterAfterUnlimited === 1n &&
        spenderAfterUnlimited - spenderBeforeUnlimited === 1n,
    },
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    oreAddress,
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    recipient: recipient.address,
    spender: spender.address,
    skipHunts: SKIP_HUNTS,
    recovery,
    initial,
    negative,
    cycles,
    transfers: transferChecks,
    final,
    ok:
      negative.every((item) => item.ok) &&
      cycles.every((cycle) => cycle.rewardEqualsSupplyAndEmittedDelta && cycle.supplyWithinCapAfter) &&
      Object.values(transferChecks).every((item) => item.ok) &&
      final.supplyWithinCap &&
      final.supplyWithinMax,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
