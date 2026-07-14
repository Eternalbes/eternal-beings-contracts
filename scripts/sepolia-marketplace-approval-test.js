const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-3-wallet-batch-test-mint.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-3-wallet-batch-test-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v4-marketplace-approval-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-marketplace-approval-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [outputPath]",
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

async function txInfo(tx) {
  const receipt = await tx.wait();
  return {
    tx: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const liveClaims = [];
  for (const claim of claimReport.claims || []) {
    if (!claim.ok || !claim.tokenId) continue;
    try {
      const owner = await gameRead.ownerOf(BigInt(claim.tokenId));
      if (owner.toLowerCase() === claim.address.toLowerCase()) liveClaims.push(claim);
    } catch {
      // Ignore burned tokens.
    }
  }
  if (liveClaims.length < 2) throw new Error("need at least 2 live tokens owned by their claim wallets");

  const ownerClaim = liveClaims[0];
  const operatorClaim = liveClaims[1];
  const tokenId = BigInt(ownerClaim.tokenId);
  const owner = new ethers.Wallet(secretForAddress(secrets, ownerClaim.address), provider);
  const operator = new ethers.Wallet(secretForAddress(secrets, operatorClaim.address), provider);
  const gameOwner = gameRead.connect(owner);
  const gameOperator = gameRead.connect(operator);

  const before = {
    tokenId: tokenId.toString(),
    owner: await gameRead.ownerOf(tokenId),
    approved: await gameRead.getApproved(tokenId),
    operatorApproved: await gameRead.isApprovedForAll(owner.address, operator.address),
  };

  const negative = [
    await expectRevert("operator cannot transfer before approval", () =>
      gameOperator.transferFrom(owner.address, operator.address, tokenId, { gasLimit: 140000n }),
    ),
  ];

  const approve = await txInfo(await gameOwner.approve(operator.address, tokenId, { gasLimit: 90000n }));
  const approvedAfterApprove = await gameRead.getApproved(tokenId);
  const approvedTransfer = await txInfo(
    await gameOperator.transferFrom(owner.address, operator.address, tokenId, { gasLimit: 140000n }),
  );
  const ownerAfterApprovedTransfer = await gameRead.ownerOf(tokenId);
  const approvalAfterTransfer = await gameRead.getApproved(tokenId);
  const returnAfterApproveFlow = await txInfo(
    await gameOperator.transferFrom(operator.address, owner.address, tokenId, { gasLimit: 140000n }),
  );

  const setApprovalForAll = await txInfo(
    await gameOwner.setApprovalForAll(operator.address, true, { gasLimit: 90000n }),
  );
  const operatorApproved = await gameRead.isApprovedForAll(owner.address, operator.address);
  const operatorTransfer = await txInfo(
    await gameOperator.transferFrom(owner.address, operator.address, tokenId, { gasLimit: 140000n }),
  );
  const ownerAfterOperatorTransfer = await gameRead.ownerOf(tokenId);
  const returnAfterOperatorFlow = await txInfo(
    await gameOperator.transferFrom(operator.address, owner.address, tokenId, { gasLimit: 140000n }),
  );
  const clearApprovalForAll = await txInfo(
    await gameOwner.setApprovalForAll(operator.address, false, { gasLimit: 90000n }),
  );

  const finalState = {
    owner: await gameRead.ownerOf(tokenId),
    approved: await gameRead.getApproved(tokenId),
    operatorApproved: await gameRead.isApprovedForAll(owner.address, operator.address),
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    tokenId: tokenId.toString(),
    owner: owner.address,
    operator: operator.address,
    before,
    negative,
    approve,
    approvedAfterApprove,
    approvedTransfer,
    ownerAfterApprovedTransfer,
    approvalAfterTransfer,
    returnAfterApproveFlow,
    setApprovalForAll,
    operatorApproved,
    operatorTransfer,
    ownerAfterOperatorTransfer,
    returnAfterOperatorFlow,
    clearApprovalForAll,
    finalState,
    ok:
      negative.every((item) => item.ok) &&
      approvedAfterApprove.toLowerCase() === operator.address.toLowerCase() &&
      ownerAfterApprovedTransfer.toLowerCase() === operator.address.toLowerCase() &&
      approvalAfterTransfer === ethers.ZeroAddress &&
      operatorApproved === true &&
      ownerAfterOperatorTransfer.toLowerCase() === operator.address.toLowerCase() &&
      finalState.owner.toLowerCase() === owner.address.toLowerCase() &&
      finalState.approved === ethers.ZeroAddress &&
      finalState.operatorApproved === false,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
