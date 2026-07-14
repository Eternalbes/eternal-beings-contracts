const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  tokenIdRaw = "1",
  countRaw = "5",
  externalBaseTokenRaw = "950000",
  claimReportPath = "reports/sepolia-fast-v4-2-wallet-mint-cycle.claim.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-2-wallet-mint-cycle.secrets.json",
  outputPath = "reports/sepolia-fast-v4-external-devour-endurance-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-external-devour-endurance-test.js <rpcUrl> <gameAddress> [tokenId] [count] [externalBaseTokenId] [claimReport] [secretsPath] [outputPath]",
      "",
      "Runs repeated ordinary external NFT devours on Sepolia and verifies lock, counters, events, metadata, and cap state.",
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

async function waitCooldown(provider, game, tokenId) {
  for (;;) {
    const [blockNumber, cooldown] = await Promise.all([provider.getBlockNumber(), game.cooldownUntil(tokenId)]);
    if (BigInt(blockNumber) >= cooldown) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
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

async function metadataSnapshot(game, tokenId) {
  const tokenURI = await game.tokenURI(tokenId);
  const prefix = "data:application/json;base64,";
  if (!tokenURI.startsWith(prefix)) throw new Error("unexpected tokenURI prefix");
  const metadata = JSON.parse(Buffer.from(tokenURI.slice(prefix.length), "base64").toString("utf8"));
  return {
    tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
    imagePrefix: String(metadata.image || "").slice(0, 30),
    attributes: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
  };
}

function parsedEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {
      // Ignore external ERC721 logs.
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
  const count = Number(countRaw);
  const externalBaseTokenId = BigInt(externalBaseTokenRaw);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("count must be positive");

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
  const externalArtifact = readJson("artifacts/TestExternalNFT.json");
  const hunter = new ethers.Wallet(secretForAddress(secrets, tokenClaim.address), provider);
  const other = new ethers.Wallet(secretForAddress(secrets, otherClaim.address), provider);
  const gameRead = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const game = gameRead.connect(hunter);

  const owner = await gameRead.ownerOf(tokenId);
  if (owner.toLowerCase() === gameAddress.toLowerCase()) {
    const hunt = await gameRead.hunts(tokenId);
    if (hunt.owner.toLowerCase() !== hunter.address.toLowerCase()) {
      throw new Error(`token is hunting under unexpected owner ${hunt.owner}`);
    }
    await (await game.resolveHunt(tokenId, { gasLimit: 360000n })).wait();
  } else if (owner.toLowerCase() !== hunter.address.toLowerCase()) {
    throw new Error(`token ${tokenId} owner is ${owner}, expected ${hunter.address}`);
  }

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, hunter);
  const external = await externalFactory.deploy({ gasLimit: 900000n });
  const deployReceipt = await external.deploymentTransaction().wait();
  const externalAddress = await external.getAddress();
  const externalOther = external.connect(other);

  const initial = {
    blockNumber: await provider.getBlockNumber(),
    owner: await gameRead.ownerOf(tokenId),
    being: viewBeing(await gameRead.getBeing(tokenId)),
    tokenURI: await metadataSnapshot(gameRead, tokenId),
    unknownCollectionDevours: (await gameRead.unknownCollectionDevours(externalAddress)).toString(),
    collectionLimit: (await gameRead.UNKNOWN_COLLECTION_DEVOUR_LIMIT()).toString(),
  };

  const steps = [];
  for (let i = 0; i < count; i++) {
    await waitCooldown(provider, gameRead, tokenId);
    const externalTokenId = externalBaseTokenId + BigInt(i);
    const before = {
      blockNumber: await provider.getBlockNumber(),
      being: viewBeing(await gameRead.getBeing(tokenId)),
      metadata: await metadataSnapshot(gameRead, tokenId),
      unknownCollectionDevours: await gameRead.unknownCollectionDevours(externalAddress),
    };

    const mintTx = await external.mintWithSupply(hunter.address, externalTokenId, 1000n + BigInt(i), { gasLimit: 140000n });
    const mintReceipt = await mintTx.wait();
    const approveTx = await external.approve(gameAddress, externalTokenId, { gasLimit: 90000n });
    const approveReceipt = await approveTx.wait();
    const observeTx = await game.observeExternal(externalAddress, externalTokenId, { gasLimit: 150000n });
    const observeReceipt = await observeTx.wait();
    const statusBeforeDevour = {
      owner: await external.ownerOf(externalTokenId),
      observedOwner: (await gameRead.externalObservations(externalAddress, externalTokenId)).owner,
      devouredFlag: await gameRead.devouredExternal(externalAddress, externalTokenId),
    };

    await waitCooldown(provider, gameRead, tokenId);
    const devourTx = await game.devourExternal(tokenId, externalAddress, externalTokenId, { gasLimit: 340000n });
    const devourReceipt = await devourTx.wait();
    const devoured = parsedEvent(gameRead, devourReceipt, "Devoured");
    const metadataUpdate = parsedEvent(gameRead, devourReceipt, "MetadataUpdate");
    const after = {
      blockNumber: await provider.getBlockNumber(),
      externalOwner: await external.ownerOf(externalTokenId),
      devouredFlag: await gameRead.devouredExternal(externalAddress, externalTokenId),
      observationOwnerAfter: (await gameRead.externalObservations(externalAddress, externalTokenId)).owner,
      being: viewBeing(await gameRead.getBeing(tokenId)),
      metadata: await metadataSnapshot(gameRead, tokenId),
      cooldownUntil: (await gameRead.cooldownUntil(tokenId)).toString(),
      unknownCollectionDevours: await gameRead.unknownCollectionDevours(externalAddress),
    };

    const negative = [
      await expectRevert("same external NFT cannot be devoured twice", () =>
        game.devourExternal(tokenId, externalAddress, externalTokenId),
      ),
      await expectRevert("original owner cannot pull locked NFT", () =>
        external.transferFrom(gameAddress, hunter.address, externalTokenId),
      ),
      await expectRevert("other wallet cannot pull locked NFT", () =>
        externalOther.transferFrom(gameAddress, other.address, externalTokenId),
      ),
      await expectRevert("old owner cannot approve locked NFT", () => external.approve(hunter.address, externalTokenId)),
    ];

    steps.push({
      index: i + 1,
      externalTokenId: externalTokenId.toString(),
      before: {
        blockNumber: before.blockNumber,
        being: before.being,
        tokenURIBytes: before.metadata.tokenURIBytes,
        unknownCollectionDevours: before.unknownCollectionDevours.toString(),
      },
      mint: { tx: mintReceipt.hash, blockNumber: mintReceipt.blockNumber, gasUsed: mintReceipt.gasUsed.toString() },
      approve: { tx: approveReceipt.hash, blockNumber: approveReceipt.blockNumber, gasUsed: approveReceipt.gasUsed.toString() },
      observe: { tx: observeReceipt.hash, blockNumber: observeReceipt.blockNumber, gasUsed: observeReceipt.gasUsed.toString() },
      statusBeforeDevour,
      devour: {
        tx: devourReceipt.hash,
        blockNumber: devourReceipt.blockNumber,
        gasUsed: devourReceipt.gasUsed.toString(),
        eventBeingId: devoured ? devoured.args.beingId.toString() : null,
        eventTier: devoured ? devoured.args.tier.toString() : null,
        metadataUpdateTokenId: metadataUpdate ? metadataUpdate.args.tokenId.toString() : null,
      },
      after: {
        blockNumber: after.blockNumber,
        externalOwner: after.externalOwner,
        devouredFlag: after.devouredFlag,
        observationOwnerAfter: after.observationOwnerAfter,
        being: after.being,
        tokenURIBytes: after.metadata.tokenURIBytes,
        cooldownUntil: after.cooldownUntil,
        unknownCollectionDevours: after.unknownCollectionDevours.toString(),
      },
      negative,
      ok:
        statusBeforeDevour.owner.toLowerCase() === hunter.address.toLowerCase() &&
        statusBeforeDevour.observedOwner.toLowerCase() === hunter.address.toLowerCase() &&
        after.externalOwner.toLowerCase() === gameAddress.toLowerCase() &&
        after.devouredFlag === true &&
        after.observationOwnerAfter === ethers.ZeroAddress &&
        BigInt(after.being.devours) === BigInt(before.being.devours) + 1n &&
        BigInt(after.being.mass) > BigInt(before.being.mass) &&
        BigInt(after.being.complexity) > BigInt(before.being.complexity) &&
        after.unknownCollectionDevours === before.unknownCollectionDevours + 1n &&
        devoured !== null &&
        devoured.args.tier === 0n &&
        metadataUpdate !== null &&
        negative.every((item) => item.ok),
    });
  }

  const final = {
    blockNumber: await provider.getBlockNumber(),
    owner: await gameRead.ownerOf(tokenId),
    being: viewBeing(await gameRead.getBeing(tokenId)),
    tokenURI: await metadataSnapshot(gameRead, tokenId),
    unknownCollectionDevours: (await gameRead.unknownCollectionDevours(externalAddress)).toString(),
  };
  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    tokenId: tokenId.toString(),
    hunter: hunter.address,
    external: {
      address: externalAddress,
      deployTx: deployReceipt.hash,
      deployBlockNumber: deployReceipt.blockNumber,
      deployGasUsed: deployReceipt.gasUsed.toString(),
    },
    count,
    initial,
    steps,
    final,
    ok:
      final.owner.toLowerCase() === hunter.address.toLowerCase() &&
      BigInt(final.being.devours) === BigInt(initial.being.devours) + BigInt(count) &&
      BigInt(final.unknownCollectionDevours) === BigInt(count) &&
      steps.every((step) => step.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
