const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { buildTree, proofFor } = require("./merkle");

async function mine(provider, blocks = 1) {
  for (let i = 0; i < blocks; i++) await provider.send("evm_mine", []);
}

async function mineUntil(provider, targetBlock) {
  const current = BigInt(await provider.send("eth_blockNumber", []));
  const target = BigInt(targetBlock);
  if (target > current) await mine(provider, Number(target - current));
}

async function assertRejects(txThunk, message) {
  let rejected = false;
  try {
    const tx = await txThunk();
    if (tx && typeof tx.wait === "function") await tx.wait();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function mintBeing(provider, game, signer, secretText, expectedTokenId) {
  let epoch = await game.currentEpoch();
  let start = await game.epochStart(epoch);
  const commitBlocks = await game.COMMIT_BLOCKS();
  let current = BigInt(await provider.send("eth_blockNumber", []));
  if (current > start || current + 1n >= start + commitBlocks) {
    await mineUntil(provider, start + await game.EPOCH_BLOCKS());
    epoch = await game.currentEpoch();
    start = await game.epochStart(epoch);
  }

  const secret = ethers.keccak256(ethers.toUtf8Bytes(secretText));
  const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await signer.getAddress(), epoch, secret]);
  await (await game.connect(signer).commitMint(commitment)).wait();
  await mineUntil(provider, start + commitBlocks);
  await (await game.connect(signer).revealMint(epoch, secret)).wait();
  await mineUntil(provider, start + await game.EPOCH_BLOCKS());
  await (await game.connect(signer).claimMint(epoch)).wait();
  assert.equal(await game.ownerOf(expectedTokenId), await signer.getAddress(), `owner of #${expectedTokenId}`);
}

async function deployGame(rendererFactory, gameFactory, root, receiver, rendererAddress = null) {
  let renderer = null;
  if (!rendererAddress) {
    renderer = await rendererFactory.deploy();
    await renderer.waitForDeployment();
    rendererAddress = await renderer.getAddress();
  }
  const game = await gameFactory.deploy(root, receiver, rendererAddress);
  await game.waitForDeployment();
  return { game, rendererAddress };
}

async function main() {
  for (const artifact of [
    "artifacts/EternalBeings.json",
    "artifacts/EternalRenderer.json",
    "artifacts/TestExternalNFT.json",
  ]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [alice, bob] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();

  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);

  const unknownExternal = await externalFactory.deploy();
  await unknownExternal.waitForDeployment();
  const unknownAddress = await unknownExternal.getAddress();
  const { game } = await deployGame(rendererFactory, gameFactory, ethers.ZeroHash, aliceAddress);
  const gameAddress = await game.getAddress();
  await mintBeing(provider, game, alice, "unknown-cap", 1);
  const minUnknownSupply = await game.UNKNOWN_MIN_TOTAL_SUPPLY();

  if (minUnknownSupply > 1n) {
    await (await unknownExternal.mintWithSupply(aliceAddress, 1, minUnknownSupply - 1n)).wait();
    await assertRejects(
      () => game.observeExternal(unknownAddress, 1),
      "unknown collection below minimum supply cannot be observed",
    );
  }

  await (await unknownExternal.mintWithSupply(aliceAddress, 2, minUnknownSupply)).wait();
  await (await game.observeExternal(unknownAddress, 2)).wait();
  await (await unknownExternal.transferFrom(aliceAddress, bobAddress, 2)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await assertRejects(
    () => game.devourExternal(1, unknownAddress, 2),
    "observed external NFT cannot be devoured after ownership changes",
  );

  await (await unknownExternal.connect(bob).transferFrom(bobAddress, aliceAddress, 2)).wait();
  await (await game.observeExternal(unknownAddress, 2)).wait();
  await (await unknownExternal.approve(gameAddress, 2)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.devourExternal(1, unknownAddress, 2, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.unknownCollectionDevours(unknownAddress), 1n, "unknown devour counter starts at one");

  for (let i = 3; i <= 101; i++) {
    await (await unknownExternal.mintWithSupply(aliceAddress, i, 1000 + i)).wait();
    await (await unknownExternal.approve(gameAddress, i)).wait();
    await (await game.observeExternal(unknownAddress, i)).wait();
    await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
    await mine(provider, 1);
    await (await game.devourExternal(1, unknownAddress, i, { gasLimit: 1_000_000 })).wait();
  }
  assert.equal(await game.unknownCollectionDevours(unknownAddress), 100n, "unknown collection reaches cap");

  await (await unknownExternal.mintWithSupply(aliceAddress, 102, 1200)).wait();
  await (await unknownExternal.approve(gameAddress, 102)).wait();
  await (await game.observeExternal(unknownAddress, 102)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await assertRejects(
    () => game.devourExternal(1, unknownAddress, 102),
    "unknown collection cannot be devoured once cap is filled",
  );

  const tieredExternal = await externalFactory.deploy();
  await tieredExternal.waitForDeployment();
  const tieredAddress = await tieredExternal.getAddress();
  const entries = [
    { address: tieredAddress, tier: 5 },
    { address: unknownAddress, tier: 1 },
  ];
  const tree = buildTree(entries);
  const tierProof = proofFor(0, tree.layers);
  const badProof = proofFor(1, tree.layers);
  const { game: tieredGame } = await deployGame(rendererFactory, gameFactory, tree.root, aliceAddress);
  const tieredGameAddress = await tieredGame.getAddress();
  await mintBeing(provider, tieredGame, alice, "tiered-proof", 1);
  await (await tieredExternal.mintWithSupply(aliceAddress, 501, 1)).wait();
  await (await tieredExternal.approve(tieredGameAddress, 501)).wait();

  assert.equal(await tieredGame.verifyCollectionTier(tieredAddress, 5, tierProof), true, "tier 5 proof verifies");
  assert.equal(await tieredGame.verifyCollectionTier(tieredAddress, 4, tierProof), false, "same proof fails for wrong tier");
  assert.equal(await tieredGame.verifyCollectionTier(tieredAddress, 5, badProof), false, "wrong proof rejected");
  await assertRejects(
    () => tieredGame.devourTieredExternal(1, tieredAddress, 501, 5, badProof),
    "bad tiered proof cannot devour",
  );

  const beforeTiered = await tieredGame.getBeing(1);
  await (await tieredGame.devourTieredExternal(1, tieredAddress, 501, 5, tierProof, { gasLimit: 1_000_000 })).wait();
  const afterTiered = await tieredGame.getBeing(1);
  assert.equal(await tieredExternal.ownerOf(501), tieredGameAddress, "tiered NFT locked");
  assert.equal(await tieredGame.unknownCollectionDevours(tieredAddress), 0n, "tiered devour does not consume unknown collection cap");
  assert(afterTiered.premiumDevours > beforeTiered.premiumDevours, "tiered devour increments premium devours");
  assert(afterTiered.power > beforeTiered.power, "tiered devour increases power");
  assert(afterTiered.skill > beforeTiered.skill, "tiered devour increases skill");

  console.log(
    JSON.stringify(
      {
        status: "evolution-edge-test ok",
        unknownCollectionDevours: (await game.unknownCollectionDevours(unknownAddress)).toString(),
        tiered: {
          premiumDevoursBefore: beforeTiered.premiumDevours.toString(),
          premiumDevoursAfter: afterTiered.premiumDevours.toString(),
          powerBefore: beforeTiered.power.toString(),
          powerAfter: afterTiered.power.toString(),
          skillBefore: beforeTiered.skill.toString(),
          skillAfter: afterTiered.skill.toString(),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
