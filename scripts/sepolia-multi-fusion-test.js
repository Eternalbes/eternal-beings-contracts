const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-3-wallet-batch-test-mint.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-3-wallet-batch-test-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v4-multi-fusion-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-multi-fusion-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [outputPath]",
      "",
      "Uses at least three live claimed Beings. The lowest tokenId is the parent; the others are fused one by one.",
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
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);

  const liveClaims = [];
  for (const claim of claimReport.claims || []) {
    if (!claim.ok || !claim.tokenId) continue;
    const tokenId = BigInt(claim.tokenId);
    const owner = await optionalOwner(gameRead, tokenId);
    if (owner) liveClaims.push({ ...claim, tokenId, owner });
  }
  liveClaims.sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
  if (liveClaims.length < 3) throw new Error(`need at least 3 live tokens, got ${liveClaims.length}`);

  const parent = liveClaims[0];
  const sacrifices = liveClaims.slice(1, 3);
  const parentWallet = new ethers.Wallet(privateKeyFor(secrets, parent.address), provider);
  const gameAsParent = gameRead.connect(parentWallet);
  const parentId = parent.tokenId;

  const before = {
    blockNumber: await provider.getBlockNumber(),
    totalMinted: (await gameRead.totalMinted()).toString(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentId),
    parent: viewBeing(await gameRead.getBeing(parentId)),
    sacrifices: [],
  };
  for (const sacrifice of sacrifices) {
    before.sacrifices.push({
      tokenId: sacrifice.tokenId.toString(),
      owner: await gameRead.ownerOf(sacrifice.tokenId),
      being: viewBeing(await gameRead.getBeing(sacrifice.tokenId)),
    });
  }

  const steps = [];
  for (const sacrifice of sacrifices) {
    const sacrificeId = sacrifice.tokenId;
    const sacrificeOwner = await gameRead.ownerOf(sacrificeId);
    let transfer = null;
    if (sacrificeOwner.toLowerCase() !== parentWallet.address.toLowerCase()) {
      const sacrificeWallet = new ethers.Wallet(privateKeyFor(secrets, sacrifice.address), provider);
      const tx = await gameRead
        .connect(sacrificeWallet)
        .transferFrom(sacrificeWallet.address, parentWallet.address, sacrificeId, { gasLimit: 140000n });
      const receipt = await tx.wait();
      transfer = {
        tx: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      };
    }

    await waitPastCooldown(provider, gameRead, parentId);
    const beforeFuse = {
      blockNumber: await provider.getBlockNumber(),
      aliveSupply: (await gameRead.aliveSupply()).toString(),
      parent: viewBeing(await gameRead.getBeing(parentId)),
    };
    const fuseTx = await gameAsParent.fuseBeing(parentId, sacrificeId, { gasLimit: 500000n });
    const fuseReceipt = await fuseTx.wait();
    const afterFuse = {
      blockNumber: await provider.getBlockNumber(),
      aliveSupply: (await gameRead.aliveSupply()).toString(),
      parentOwner: await gameRead.ownerOf(parentId),
      sacrificeOwner: await optionalOwner(gameRead, sacrificeId),
      parent: viewBeing(await gameRead.getBeing(parentId)),
      cooldownUntil: (await gameRead.cooldownUntil(parentId)).toString(),
    };
    steps.push({
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
        BigInt(afterFuse.aliveSupply) + 1n === BigInt(beforeFuse.aliveSupply),
    });
  }

  const tokenURI = await gameRead.tokenURI(parentId);
  const finalState = {
    blockNumber: await provider.getBlockNumber(),
    totalMinted: (await gameRead.totalMinted()).toString(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentId),
    parent: viewBeing(await gameRead.getBeing(parentId)),
    tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    parentId: parentId.toString(),
    sacrificeIds: sacrifices.map((sacrifice) => sacrifice.tokenId.toString()),
    before,
    steps,
    finalState,
    ok:
      steps.every((step) => step.ok) &&
      BigInt(finalState.aliveSupply) + BigInt(steps.length) === BigInt(before.aliveSupply) &&
      BigInt(finalState.parent.mass) > BigInt(before.parent.mass) &&
      BigInt(finalState.parent.complexity) > BigInt(before.parent.complexity) &&
      BigInt(finalState.parent.fusions) >= BigInt(before.parent.fusions) + BigInt(steps.length),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
