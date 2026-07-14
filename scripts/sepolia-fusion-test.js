const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-2-wallet-mint-cycle.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-2-wallet-mint-cycle.secrets.json",
  parentIdRaw = "1",
  sacrificeIdRaw = "2",
  outputPath = "reports/sepolia-fast-v4-fusion-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-fusion-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [parentId] [sacrificeId] [outputPath]",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function findClaim(claimReport, tokenId) {
  const claim = (claimReport.claims || []).find((entry) => entry.ok && String(entry.tokenId) === String(tokenId));
  if (!claim) throw new Error(`missing claim for token ${tokenId}`);
  return claim;
}

function privateKeyFor(secrets, address) {
  const entry = (secrets.wallets || []).find((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
  if (!entry) throw new Error(`missing private key for ${address}`);
  return entry.privateKey;
}

function beingView(being) {
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
  } catch (error) {
    return null;
  }
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const parentId = BigInt(parentIdRaw);
  const sacrificeId = BigInt(sacrificeIdRaw);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const parentClaim = findClaim(claimReport, parentId);
  const sacrificeClaim = findClaim(claimReport, sacrificeId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const parentWallet = new ethers.Wallet(privateKeyFor(secrets, parentClaim.address), provider);
  const sacrificeWallet = new ethers.Wallet(privateKeyFor(secrets, sacrificeClaim.address), provider);
  const gameAsParent = gameRead.connect(parentWallet);
  const gameAsSacrifice = gameRead.connect(sacrificeWallet);

  const before = {
    totalMinted: (await gameRead.totalMinted()).toString(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentId),
    sacrificeOwner: await gameRead.ownerOf(sacrificeId),
    parent: beingView(await gameRead.getBeing(parentId)),
    sacrifice: beingView(await gameRead.getBeing(sacrificeId)),
  };

  let transfer = null;
  if (before.sacrificeOwner.toLowerCase() !== parentWallet.address.toLowerCase()) {
    const tx = await gameAsSacrifice.transferFrom(sacrificeWallet.address, parentWallet.address, sacrificeId, {
      gasLimit: 140000n,
    });
    const receipt = await tx.wait();
    transfer = {
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  const fusionTx = await gameAsParent.fuseBeing(parentId, sacrificeId, { gasLimit: 420000n });
  const fusionReceipt = await fusionTx.wait();

  const after = {
    totalMinted: (await gameRead.totalMinted()).toString(),
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    parentOwner: await gameRead.ownerOf(parentId),
    sacrificeOwner: await optionalOwner(gameRead, sacrificeId),
    parent: beingView(await gameRead.getBeing(parentId)),
    sacrificeBurned: (await optionalOwner(gameRead, sacrificeId)) === null,
    cooldownUntil: (await gameRead.cooldownUntil(parentId)).toString(),
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    parentId: parentId.toString(),
    sacrificeId: sacrificeId.toString(),
    parentWallet: parentWallet.address,
    sacrificeWallet: sacrificeWallet.address,
    before,
    transfer,
    fusion: {
      tx: fusionReceipt.hash,
      blockNumber: fusionReceipt.blockNumber,
      gasUsed: fusionReceipt.gasUsed.toString(),
    },
    after,
    ok:
      after.parentOwner.toLowerCase() === parentWallet.address.toLowerCase() &&
      after.sacrificeBurned &&
      BigInt(before.aliveSupply) === BigInt(after.aliveSupply) + 1n,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
