const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  tokenIdRaw = "1",
  externalTokenIdRaw = "888001",
  claimReportPath = "reports/sepolia-fast-v3-5-wallet-mint.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v3-5-wallet-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v3-locked-nft-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-locked-nft-test.js <rpcUrl> <gameAddress> [beingTokenId] [externalTokenId] [claimReport] [secretsPath] [outputPath]",
      "",
      "Deploys a test ERC721, devours it, then verifies the locked NFT cannot be pulled back.",
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

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  for (const artifact of ["artifacts/EternalBeings.json", "artifacts/TestExternalNFT.json"]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const beingTokenId = BigInt(tokenIdRaw);
  const externalTokenId = BigInt(externalTokenIdRaw);
  const claimReport = readJson(claimReportPath);
  const secretReport = readJson(secretsPath);
  const tokenClaim = findClaimByToken(claimReport, beingTokenId);
  if (!tokenClaim) throw new Error(`claim report has no tokenId ${beingTokenId}`);
  const otherClaim = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== tokenClaim.address.toLowerCase(),
  );
  if (!otherClaim) throw new Error("claim report has no secondary wallet");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const hunter = new ethers.Wallet(secretForAddress(secretReport, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secretReport, otherClaim.address), provider);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const game = gameRead.connect(hunter);

  const owner = await gameRead.ownerOf(beingTokenId);
  const recovery = [];
  if (owner.toLowerCase() === gameAddress.toLowerCase()) {
    const hunt = await gameRead.hunts(beingTokenId);
    if (hunt.owner.toLowerCase() !== hunter.address.toLowerCase()) {
      throw new Error(`being is locked in hunt by unexpected owner ${hunt.owner}`);
    }
    const tx = await game.resolveHunt(beingTokenId, { gasLimit: 360000n });
    const receipt = await tx.wait();
    recovery.push({
      action: "resolved pre-existing hunt",
      tx: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  } else if (owner.toLowerCase() !== hunter.address.toLowerCase()) {
    throw new Error(`being ${beingTokenId} owner is ${owner}, expected ${hunter.address}`);
  }

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, hunter);
  const external = await externalFactory.deploy({ gasLimit: 900000n });
  const externalDeploy = await external.deploymentTransaction().wait();
  const externalAddress = await external.getAddress();
  const externalOther = external.connect(other);

  const mintTx = await external.mintWithSupply(hunter.address, externalTokenId, 1000n, { gasLimit: 140000n });
  const mintReceipt = await mintTx.wait();
  const approveTx = await external.approve(gameAddress, externalTokenId, { gasLimit: 80000n });
  const approveReceipt = await approveTx.wait();
  const observeTx = await game.observeExternal(externalAddress, externalTokenId, { gasLimit: 140000n });
  const observeReceipt = await observeTx.wait();
  const devourTx = await game.devourExternal(beingTokenId, externalAddress, externalTokenId, { gasLimit: 260000n });
  const devourReceipt = await devourTx.wait();

  const ownerAfterDevour = await external.ownerOf(externalTokenId);
  const devouredFlag = await gameRead.devouredExternal(externalAddress, externalTokenId);
  const beingAfter = await gameRead.getBeing(beingTokenId);

  const negative = [
    await expectRevert("original owner cannot transfer locked NFT from game", () =>
      external.transferFrom(gameAddress, hunter.address, externalTokenId),
    ),
    await expectRevert("other wallet cannot transfer locked NFT from game", () =>
      externalOther.transferFrom(gameAddress, other.address, externalTokenId),
    ),
    await expectRevert("original owner cannot approve locked NFT", () =>
      external.approve(hunter.address, externalTokenId),
    ),
    await expectRevert("setting old owner operator approval still cannot move locked NFT", async () => {
      const tx = await external.setApprovalForAll(other.address, true, { gasLimit: 80000n });
      await tx.wait();
      return externalOther.transferFrom(gameAddress, other.address, externalTokenId);
    }),
    await expectRevert("same external NFT cannot be devoured twice", () =>
      game.devourExternal(beingTokenId, externalAddress, externalTokenId),
    ),
  ];

  const ownerAfterAttacks = await external.ownerOf(externalTokenId);
  const gameBalance = await external.balanceOf(gameAddress);
  const hunterBalance = await external.balanceOf(hunter.address);
  const otherBalance = await external.balanceOf(other.address);

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    beingTokenId: beingTokenId.toString(),
    hunter: hunter.address,
    other: other.address,
    recovery,
    external: {
      address: externalAddress,
      tokenId: externalTokenId.toString(),
      deployTx: externalDeploy.hash,
      deployGasUsed: externalDeploy.gasUsed.toString(),
      mintTx: mintReceipt.hash,
      approveTx: approveReceipt.hash,
      observeTx: observeReceipt.hash,
      devourTx: devourReceipt.hash,
      devourGasUsed: devourReceipt.gasUsed.toString(),
    },
    lockState: {
      ownerAfterDevour,
      ownerAfterAttacks,
      devouredFlag,
      gameBalance: gameBalance.toString(),
      hunterBalance: hunterBalance.toString(),
      otherBalance: otherBalance.toString(),
      being: {
        mass: beingAfter.mass.toString(),
        complexity: beingAfter.complexity.toString(),
        devours: beingAfter.devours.toString(),
        fusions: beingAfter.fusions.toString(),
      },
    },
    negative,
    ok:
      ownerAfterDevour.toLowerCase() === gameAddress.toLowerCase() &&
      ownerAfterAttacks.toLowerCase() === gameAddress.toLowerCase() &&
      devouredFlag === true &&
      gameBalance >= 1n &&
      hunterBalance === 0n &&
      otherBalance === 0n &&
      negative.every((item) => item.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
