const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  parentTokenIdRaw = "3",
  parentClaimReportPath = "reports/sepolia-fast-v4-3-wallet-batch-test-mint.json",
  parentSecretsPath = "reports/secrets/sepolia-fast-v4-3-wallet-batch-test-mint.secrets.json",
  sacrificeClaimReportPath = "reports/sepolia-fast-v4-5-wallet-fusion-sacrifices.json",
  sacrificeSecretsPath = "reports/secrets/sepolia-fast-v4-5-wallet-fusion-sacrifices.secrets.json",
  outputPath = "reports/sepolia-fast-v4-fuse5-sacrifices-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-fuse5-sacrifices-test.js <rpcUrl> <gameAddress> [parentTokenId] [parentClaimReport] [parentSecrets] [sacrificeClaimReport] [sacrificeSecrets] [outputPath]",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function privateKeyFor(secrets, address) {
  const entry = (secrets.wallets || []).find((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
  if (!entry) throw new Error(`missing private key for ${address}`);
  return entry.privateKey;
}

function claimForToken(claimReport, tokenId) {
  const claim = (claimReport.claims || []).find((entry) => entry.ok && String(entry.tokenId) === String(tokenId));
  if (!claim) throw new Error(`missing claim for token ${tokenId}`);
  return claim;
}

function viewBeing(being) {
  return {
    mass: being.mass.toString(),
    complexity: being.complexity.toString(),
    devours: being.devours.toString(),
    fusions: being.fusions.toString(),
    premiumDevours: being.premiumDevours.toString(),
    power: being.power.toString(),
    skill: being.skill.toString(),
    scars: being.scars.toString(),
    stage: being.stage.toString(),
    lineageMask: being.lineageMask.toString(),
    markLuck: being.markLuck.toString(),
    genome: being.genome,
  };
}

async function optionalOwner(game, tokenId) {
  try {
    return await game.ownerOf(tokenId);
  } catch {
    return null;
  }
}

async function waitPastCooldown(provider, game, tokenId) {
  for (;;) {
    const [blockNumber, cooldown] = await Promise.all([provider.getBlockNumber(), game.cooldownUntil(tokenId)]);
    if (BigInt(blockNumber) >= cooldown) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const parentTokenId = BigInt(parentTokenIdRaw);

  const parentClaimReport = readJson(parentClaimReportPath);
  const parentSecrets = readJson(parentSecretsPath);
  const parentClaim = claimForToken(parentClaimReport, parentTokenId);
  const parentWallet = new ethers.Wallet(privateKeyFor(parentSecrets, parentClaim.address), provider);
  const gameAsParent = gameRead.connect(parentWallet);

  const sacrificeClaimReport = readJson(sacrificeClaimReportPath);
  const sacrificeSecrets = readJson(sacrificeSecretsPath);
  const liveSacrifices = [];
  for (const claim of sacrificeClaimReport.claims || []) {
    if (!claim.ok || !claim.tokenId) continue;
    const tokenId = BigInt(claim.tokenId);
    const owner = await optionalOwner(gameRead, tokenId);
    if (owner) liveSacrifices.push({ ...claim, tokenId, owner });
  }
  liveSacrifices.sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
  if (liveSacrifices.length < 5) throw new Error(`need 5 live sacrifices, got ${liveSacrifices.length}`);

  const before = {
    blockNumber: await provider.getBlockNumber(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentTokenId),
    parent: viewBeing(await gameRead.getBeing(parentTokenId)),
    sacrifices: [],
  };
  for (const sacrifice of liveSacrifices.slice(0, 5)) {
    before.sacrifices.push({
      tokenId: sacrifice.tokenId.toString(),
      owner: await gameRead.ownerOf(sacrifice.tokenId),
      being: viewBeing(await gameRead.getBeing(sacrifice.tokenId)),
    });
  }

  if (before.parentOwner.toLowerCase() !== parentWallet.address.toLowerCase()) {
    throw new Error(`parent owner mismatch: ${before.parentOwner}, expected ${parentWallet.address}`);
  }

  const steps = [];
  for (const sacrifice of liveSacrifices.slice(0, 5)) {
    const sacrificeId = sacrifice.tokenId;
    const sacrificeOwner = await gameRead.ownerOf(sacrificeId);
    let transfer = null;
    if (sacrificeOwner.toLowerCase() !== parentWallet.address.toLowerCase()) {
      const sacrificeWallet = new ethers.Wallet(privateKeyFor(sacrificeSecrets, sacrifice.address), provider);
      const tx = await gameRead
        .connect(sacrificeWallet)
        .transferFrom(sacrificeWallet.address, parentWallet.address, sacrificeId, { gasLimit: 140000n });
      const receipt = await tx.wait();
      transfer = {
        tx: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      };
      console.log(JSON.stringify({ step: "transferred", tokenId: sacrificeId.toString(), tx: receipt.hash }));
    }

    await waitPastCooldown(provider, gameRead, parentTokenId);
    const beforeFuse = {
      blockNumber: await provider.getBlockNumber(),
      aliveSupply: (await gameRead.aliveSupply()).toString(),
      parent: viewBeing(await gameRead.getBeing(parentTokenId)),
      sacrifice: viewBeing(await gameRead.getBeing(sacrificeId)),
    };
    const fuseTx = await gameAsParent.fuseBeing(parentTokenId, sacrificeId, { gasLimit: 560000n });
    const fuseReceipt = await fuseTx.wait();
    const afterFuse = {
      blockNumber: await provider.getBlockNumber(),
      aliveSupply: (await gameRead.aliveSupply()).toString(),
      parentOwner: await gameRead.ownerOf(parentTokenId),
      sacrificeOwner: await optionalOwner(gameRead, sacrificeId),
      parent: viewBeing(await gameRead.getBeing(parentTokenId)),
      cooldownUntil: (await gameRead.cooldownUntil(parentTokenId)).toString(),
    };
    const record = {
      sacrificeId: sacrificeId.toString(),
      transfer,
      beforeFuse,
      fuse: {
        tx: fuseReceipt.hash,
        blockNumber: fuseReceipt.blockNumber,
        gasUsed: fuseReceipt.gasUsed.toString(),
      },
      afterFuse,
      ok:
        afterFuse.parentOwner.toLowerCase() === parentWallet.address.toLowerCase() &&
        afterFuse.sacrificeOwner === null &&
        BigInt(afterFuse.aliveSupply) + 1n === BigInt(beforeFuse.aliveSupply) &&
        BigInt(afterFuse.parent.fusions) === BigInt(beforeFuse.parent.fusions) + 1n,
    };
    steps.push(record);
    console.log(JSON.stringify({ step: "fused", sacrificeId: sacrificeId.toString(), tx: fuseReceipt.hash, ok: record.ok }));
  }

  const tokenURI = await gameRead.tokenURI(parentTokenId);
  const finalState = {
    blockNumber: await provider.getBlockNumber(),
    totalMinted: (await gameRead.totalMinted()).toString(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentTokenId),
    parent: viewBeing(await gameRead.getBeing(parentTokenId)),
    tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    parentTokenId: parentTokenId.toString(),
    before,
    steps,
    finalState,
    ok:
      steps.length === 5 &&
      steps.every((step) => step.ok) &&
      BigInt(finalState.aliveSupply) + 5n === BigInt(before.aliveSupply) &&
      BigInt(finalState.parent.fusions) >= BigInt(before.parent.fusions) + 5n,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
