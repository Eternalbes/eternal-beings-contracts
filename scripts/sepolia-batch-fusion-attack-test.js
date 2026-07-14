const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-3-wallet-batch-test-mint.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-3-wallet-batch-test-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v4-batch-fusion-attack-test.json",
] = process.argv.slice(2);
const funderKey = process.env.PRIVATE_KEY || "";

function usage() {
  console.error(
    [
      "Usage:",
      "  PRIVATE_KEY=... node scripts/sepolia-batch-fusion-attack-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [outputPath]",
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

async function expectRevert(label, action) {
  try {
    const tx = await action();
    if (tx && typeof tx.wait === "function") await tx.wait();
    return { label, ok: false, error: "transaction unexpectedly succeeded" };
  } catch (error) {
    return { label, ok: true, error: error.shortMessage || error.reason || error.message };
  }
}

async function main() {
  if (!rpcUrl || !gameAddress || !funderKey) {
    usage();
    process.exit(1);
  }
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const claims = (claimReport.claims || []).filter((claim) => claim.ok && claim.tokenId).slice(0, 3);
  if (claims.length < 3) throw new Error("need at least 3 claimed tokens");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderKey, provider);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const batchArtifact = JSON.parse(fs.readFileSync("artifacts/TestBatchFusion.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);

  const batchFactory = new ethers.ContractFactory(batchArtifact.abi, batchArtifact.bytecode, funder);
  const batch = await batchFactory.deploy({ gasLimit: 300000n });
  const deployReceipt = await batch.deploymentTransaction().wait();
  const batchAddress = await batch.getAddress();

  const tokenIds = claims.map((claim) => BigInt(claim.tokenId)).sort((a, b) => (a < b ? -1 : 1));
  const parentId = tokenIds[0];
  const sacrificeIds = tokenIds.slice(1);
  const wallets = new Map(
    claims.map((claim) => [BigInt(claim.tokenId).toString(), new ethers.Wallet(privateKeyFor(secrets, claim.address), provider)]),
  );

  const before = {
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    owners: {},
  };
  for (const tokenId of tokenIds) {
    before.owners[tokenId.toString()] = await gameRead.ownerOf(tokenId);
  }

  const transfersIn = [];
  for (const tokenId of tokenIds) {
    const wallet = wallets.get(tokenId.toString());
    const game = gameRead.connect(wallet);
    const tx = await game.transferFrom(wallet.address, batchAddress, tokenId, { gasLimit: 120000n });
    const receipt = await tx.wait();
    transfersIn.push({
      tokenId: tokenId.toString(),
      from: wallet.address,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  }

  const attack = await expectRevert("batch fusion same parent in one transaction must revert", () =>
    batch.batchFuse(gameAddress, parentId, sacrificeIds, { gasLimit: 700000n }),
  );

  const afterAttack = {
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    owners: {},
  };
  for (const tokenId of tokenIds) {
    afterAttack.owners[tokenId.toString()] = await gameRead.ownerOf(tokenId);
  }

  const withdrawals = [];
  for (const tokenId of tokenIds) {
    const originalOwner = before.owners[tokenId.toString()];
    const tx = await batch.withdraw(gameAddress, tokenId, originalOwner, { gasLimit: 140000n });
    const receipt = await tx.wait();
    withdrawals.push({
      tokenId: tokenId.toString(),
      to: originalOwner,
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  }

  const finalState = {
    aliveSupply: (await gameRead.aliveSupply()).toString(),
    owners: {},
  };
  for (const tokenId of tokenIds) {
    finalState.owners[tokenId.toString()] = await gameRead.ownerOf(tokenId);
  }

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    batchAddress,
    deploy: {
      tx: deployReceipt.hash,
      blockNumber: deployReceipt.blockNumber,
      gasUsed: deployReceipt.gasUsed.toString(),
    },
    parentId: parentId.toString(),
    sacrificeIds: sacrificeIds.map((id) => id.toString()),
    before,
    transfersIn,
    attack,
    afterAttack,
    withdrawals,
    finalState,
    ok:
      attack.ok &&
      before.aliveSupply === afterAttack.aliveSupply &&
      afterAttack.aliveSupply === finalState.aliveSupply &&
      tokenIds.every((tokenId) => afterAttack.owners[tokenId.toString()].toLowerCase() === batchAddress.toLowerCase()) &&
      tokenIds.every((tokenId) => finalState.owners[tokenId.toString()].toLowerCase() === before.owners[tokenId.toString()].toLowerCase()),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
