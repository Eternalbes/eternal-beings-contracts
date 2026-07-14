const assert = require("assert");
const ganache = require("ganache");
const { ethers } = require("ethers");
const fs = require("fs");
const { buildTree, proofFor } = require("./merkle");

async function mine(provider, blocks) {
  for (let i = 0; i < blocks; i++) {
    await provider.send("evm_mine", []);
  }
}

async function mineUntil(provider, targetBlock) {
  const current = BigInt(await provider.send("eth_blockNumber", []));
  const target = BigInt(targetBlock);
  if (target > current) {
    await mine(provider, Number(target - current));
  }
}

async function assertTxRejects(txThunk, message) {
  let rejected = false;
  try {
    const tx = await txThunk();
    if (tx && typeof tx.wait === "function") await tx.wait();
  } catch (_) {
    rejected = true;
  }
  assert(rejected, message);
}

function sqrtBigInt(value) {
  if (value < 2n) return value;
  let x0 = value / 2n;
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

function scoreOf(being) {
  const value =
    sqrtBigInt(being.power) * 8n +
    sqrtBigInt(being.skill) * 5n +
    sqrtBigInt(being.complexity) / 2n +
    sqrtBigInt(being.mass);
  return sqrtBigInt(value === 0n ? 1n : value);
}

async function main() {
  if (!fs.existsSync("artifacts/EternalBeings.json") || !fs.existsSync("artifacts/EternalRenderer.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [alice, bob, charlie, dave] = await Promise.all([
    provider.getSigner(0),
    provider.getSigner(1),
    provider.getSigner(2),
    provider.getSigner(3),
  ]);

  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, alice);
  async function deployGame(root = ethers.ZeroHash, receiverPromise = alice.getAddress()) {
    const renderer = await rendererFactory.deploy();
    await renderer.waitForDeployment();
    const gameContract = await factory.deploy(root, await receiverPromise, await renderer.getAddress());
    await gameContract.waitForDeployment();
    return gameContract;
  }

  const game = await deployGame();
  await game.waitForDeployment();

  const normalScore = scoreOf({ power: 100n, skill: 100n, complexity: 10_000n, mass: 10_000n });
  const hugeScore = scoreOf({ power: 100n, skill: 100n, complexity: 10_000_000_000n, mass: 10_000_000_000n });
  assert(hugeScore > normalScore, "huge attributes still increase hunt score");
  assert(hugeScore < normalScore * 40n, "huge attributes are soft-capped by nested sqrt");

  async function mintBeing(gameContract, signer, secretText, expectedTokenId) {
    let epoch = await gameContract.currentEpoch();
    let start = await gameContract.epochStart(epoch);
    const commitBlocks = await gameContract.COMMIT_BLOCKS();
    let current = BigInt(await provider.send("eth_blockNumber", []));
    if (current > start || current + 1n >= start + commitBlocks) {
      await mineUntil(provider, start + await gameContract.EPOCH_BLOCKS());
      epoch = await gameContract.currentEpoch();
      start = await gameContract.epochStart(epoch);
      current = BigInt(await provider.send("eth_blockNumber", []));
      if (current > start) {
        await mineUntil(provider, start + await gameContract.EPOCH_BLOCKS());
        epoch = await gameContract.currentEpoch();
        start = await gameContract.epochStart(epoch);
      }
    }
    const secret = ethers.keccak256(ethers.toUtf8Bytes(secretText));
    const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await signer.getAddress(), epoch, secret]);

    await (await gameContract.connect(signer).commitMint(commitment)).wait();
    await mineUntil(provider, start + commitBlocks);
    await (await gameContract.connect(signer).revealMint(epoch, secret)).wait();
    await mineUntil(provider, start + await gameContract.EPOCH_BLOCKS());
    await (await gameContract.connect(signer).claimMint(epoch)).wait();
    assert.equal(await gameContract.ownerOf(expectedTokenId), await signer.getAddress(), `owner of #${expectedTokenId}`);
  }

  async function assertMintPhases() {
    const phaseGame = await deployGame();
    assert.equal(await phaseGame.releasedMintCap(0), 333n, "epoch 0 releases first mint tranche");
    assert.equal(await phaseGame.releasedMintCap(29), 9990n, "epoch 29 releases 9990 mints");
    assert.equal(await phaseGame.releasedMintCap(30), 9999n, "epoch 30 reaches final max supply");
    assert.equal(await phaseGame.releasedMintCap(99), 9999n, "mint release stays capped");

    const epoch = await phaseGame.currentEpoch();
    const start = await phaseGame.epochStart(epoch);
    const secret = ethers.keccak256(ethers.toUtf8Bytes("phase-secret"));
    const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await alice.getAddress(), epoch, secret]);

    await assertTxRejects(() => phaseGame.revealMint.staticCall(epoch, secret), "cannot reveal before reveal phase");
    await assertTxRejects(() => phaseGame.claimMint.staticCall(epoch), "cannot claim before reveal and epoch end");
    await assertTxRejects(() => phaseGame.connect(bob).commitMint.staticCall(ethers.ZeroHash), "zero commitment rejected");
    await (await phaseGame.commitMint(commitment)).wait();
    await assertTxRejects(() => phaseGame.commitMint.staticCall(commitment), "cannot commit twice in same epoch");
    await mineUntil(provider, start + await phaseGame.COMMIT_BLOCKS());
    await assertTxRejects(() => phaseGame.revealMint.staticCall(epoch, ethers.keccak256(ethers.toUtf8Bytes("wrong-secret"))), "wrong secret rejected");
    await (await phaseGame.revealMint(epoch, secret)).wait();
    await assertTxRejects(() => phaseGame.revealMint.staticCall(epoch, secret), "cannot reveal twice");
    await assertTxRejects(() => phaseGame.claimMint.staticCall(epoch), "cannot claim before epoch ends");
    await mineUntil(provider, start + await phaseGame.EPOCH_BLOCKS());
    await (await phaseGame.claimMint(epoch)).wait();
    assert.equal(await phaseGame.totalMinted(), 1n, "claim increments total minted");
    assert.equal(await phaseGame.aliveSupply(), 1n, "claim increments alive supply");
    assert.equal(await phaseGame.revealedCount(epoch), 1n, "epoch reveal counter recorded");
    assert.equal(await phaseGame.epochClaimLimit(epoch), 1n, "epoch claim limit set from reveals");
    assert.equal(await phaseGame.epochClaimedCount(epoch), 1n, "epoch claimed counter recorded");
    await assertTxRejects(() => phaseGame.claimMint.staticCall(epoch), "cannot claim twice");
    await assertTxRejects(() => phaseGame.commitMint.staticCall(ethers.ZeroHash), "minted address cannot commit again");
  }

  await assertMintPhases();

  await mintBeing(game, alice, "alice-secret", 1);

  assert.equal(await game.ownerOf(1), await alice.getAddress(), "alice owns minted being");
  assert.equal(await game.supportsInterface("0x2a55205a"), true, "supports ERC2981 royalties");
  const royalty = await game.royaltyInfo(1, ethers.parseEther("1"));
  assert.equal(royalty[0], await alice.getAddress(), "royalty receiver fixed at deploy");
  assert.equal(royalty[1], ethers.parseEther("0.03"), "3 percent royalty");
  let being = await game.getBeing(1);
  assert(being.power > 0n, "initial power set");

  assert.equal((await game.hunts(1)).owner, ethers.ZeroAddress, "not hunting before enter");
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(1), await game.getAddress(), "hunt locks NFT in game contract");

  await assert.rejects(game.connect(bob).resolveHunt(1));
  await assert.rejects(game.resolveHunt.staticCall(1), "cannot resolve hunt in the entry block");
  await mine(provider, 100);
  const huntBeforeResolve = await game.hunts(1);
  const beingBeforeResolve = await game.getBeing(1);
  const emittedBeforeResolve = await game.totalEmitted();
  const txResolve = await game.resolveHunt(1);
  const receiptResolve = await txResolve.wait();

  assert.equal(await game.ownerOf(1), await alice.getAddress(), "resolve returns NFT");
  const oreAddress = await game.ore();
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const ore = new ethers.Contract(oreAddress, oreArtifact.abi, provider);
  const activeBlocks =
    BigInt(receiptResolve.blockNumber) - huntBeforeResolve.startBlock > huntBeforeResolve.endurance
      ? huntBeforeResolve.endurance
      : BigInt(receiptResolve.blockNumber) - huntBeforeResolve.startBlock;
  const expectedScore = scoreOf(beingBeforeResolve);
  const baseHuntRate = await game.BASE_HUNT_RATE();
  const rawReward =
    (((activeBlocks * expectedScore * baseHuntRate) / BigInt(huntBeforeResolve.difficulty)) *
      BigInt(huntBeforeResolve.tokenMultiplier)) /
    10_000n;
  const emissionStartBlock = await game.emissionStartBlock();
  const emissionPerBlock = await game.EMISSION_PER_BLOCK();
  const tokenMaxSupply = await game.TOKEN_MAX_SUPPLY();
  const emittedCapAtResolve =
    (BigInt(receiptResolve.blockNumber) - emissionStartBlock) * emissionPerBlock > tokenMaxSupply
      ? tokenMaxSupply
      : (BigInt(receiptResolve.blockNumber) - emissionStartBlock) * emissionPerBlock;
  const availableAtResolve = emittedCapAtResolve > emittedBeforeResolve ? emittedCapAtResolve - emittedBeforeResolve : 0n;
  const expectedReward = rawReward > availableAtResolve ? availableAtResolve : rawReward;
  assert.equal(await ore.balanceOf(await alice.getAddress()), expectedReward, "ORE reward follows NFT score and hunt scene");
  assert((await ore.totalSupply()) <= ethers.parseEther("21000000"), "ORE max supply respected");
  assert.equal(await ore.minter(), await game.getAddress(), "game is ORE minter");
  await assert.rejects(ore.connect(alice).mint(await alice.getAddress(), 1));
  assert((await ore.totalSupply()) <= await game.emittedCap(), "ORE supply never exceeds emission cap");
  const aliceOre = await ore.balanceOf(await alice.getAddress());
  assert(aliceOre > 0n, "hunt minted ORE to hunter");
  await (await ore.connect(alice).transfer(await bob.getAddress(), 1n)).wait();
  assert.equal(await ore.balanceOf(await bob.getAddress()), 1n, "ORE transfer works");
  await assert.rejects(ore.connect(alice).transfer(ethers.ZeroAddress, 1n));
  await assert.rejects(ore.connect(bob).transfer(await alice.getAddress(), aliceOre + 1n));
  await (await ore.connect(bob).approve(await charlie.getAddress(), 1n)).wait();
  assert.equal(await ore.allowance(await bob.getAddress(), await charlie.getAddress()), 1n, "ORE approve works");
  await assert.rejects(ore.connect(dave).transferFrom(await bob.getAddress(), await dave.getAddress(), 1n));
  await assert.rejects(ore.connect(charlie).transferFrom(await bob.getAddress(), await charlie.getAddress(), 2n));
  await (await ore.connect(charlie).transferFrom(await bob.getAddress(), await charlie.getAddress(), 1n)).wait();
  assert.equal(await ore.balanceOf(await charlie.getAddress()), 1n, "ORE transferFrom works");
  assert.equal(await ore.allowance(await bob.getAddress(), await charlie.getAddress()), 0n, "ORE allowance decreases");
  await (await ore.connect(alice).approve(await charlie.getAddress(), 5n)).wait();
  await (await ore.connect(alice).approve(await charlie.getAddress(), 3n)).wait();
  assert.equal(await ore.allowance(await alice.getAddress(), await charlie.getAddress()), 3n, "ORE approve overwrites allowance");
  await assert.rejects(ore.connect(charlie).transferFrom(await alice.getAddress(), ethers.ZeroAddress, 1n));
  const aliceBalanceBeforeUnlimited = await ore.balanceOf(await alice.getAddress());
  await (await ore.connect(alice).approve(await dave.getAddress(), ethers.MaxUint256)).wait();
  await (await ore.connect(dave).transferFrom(await alice.getAddress(), await dave.getAddress(), 1n)).wait();
  assert.equal(await ore.allowance(await alice.getAddress(), await dave.getAddress()), ethers.MaxUint256, "unlimited ORE allowance does not decrease");
  assert.equal(await ore.balanceOf(await alice.getAddress()), aliceBalanceBeforeUnlimited - 1n, "unlimited transferFrom still debits owner");
  await assert.rejects(ore.connect(charlie).transferFrom(await alice.getAddress(), await charlie.getAddress(), aliceBalanceBeforeUnlimited + 1n));
  if ((await game.COOLDOWN_BLOCKS()) > 1n) {
    await assert.rejects(game.enterHunt(1), "cooldown blocks immediate re-entry");
  }
  await mine(provider, 40);
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  await mine(provider, 10_000);
  await (await game.resolveHunt(1)).wait();
  assert((await ore.totalSupply()) <= await game.emittedCap(), "long hunt still respects emission cap");
  assert((await ore.totalSupply()) <= ethers.parseEther("21000000"), "long hunt still respects max supply");

  let previousEmitted = await game.totalEmitted();
  let previousPower = (await game.getBeing(1)).power;
  let previousSkill = (await game.getBeing(1)).skill;
  for (let round = 0; round < 6; round++) {
    await mine(provider, 40);
    await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
    const loopHunt = await game.hunts(1);
    assert.equal(await game.ownerOf(1), await game.getAddress(), "loop hunt locks NFT");
    assert(loopHunt.endurance <= (await game.MAX_ENDURANCE()), "hunt endurance capped");
    await mine(provider, 25 + round * 9);
    await (await game.resolveHunt(1)).wait();
    const loopBeing = await game.getBeing(1);
    const loopEmitted = await game.totalEmitted();
    assert.equal(await game.ownerOf(1), await alice.getAddress(), "loop hunt returns NFT");
    assert(loopEmitted >= previousEmitted, "total emitted is monotonic");
    assert(loopEmitted <= await game.emittedCap(), "loop hunt respects emission cap");
    assert((await ore.totalSupply()) <= ethers.parseEther("21000000"), "loop hunt respects max supply");
    assert(loopBeing.power >= previousPower, "power never decreases during hunt loop");
    assert(loopBeing.skill >= previousSkill, "skill never decreases during hunt loop");
    previousEmitted = loopEmitted;
    previousPower = loopBeing.power;
    previousSkill = loopBeing.skill;
  }

  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));
  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();

  await (await external.mintWithSupply(await alice.getAddress(), 77, 1000)).wait();
  await (await external.approve(await game.getAddress(), 77)).wait();

  const beforeDevour = await game.getBeing(1);
  await assert.rejects(game.devourExternal(1, await external.getAddress(), 77));
  await (await game.observeExternal(await external.getAddress(), 77)).wait();
  await assert.rejects(game.devourExternal(1, await external.getAddress(), 77));
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.devourExternal(1, await external.getAddress(), 77, { gasLimit: 1_000_000 })).wait();
  assert.equal(await external.ownerOf(77), await game.getAddress(), "external NFT locked in game");
  await assert.rejects(external.transferFrom(await game.getAddress(), await alice.getAddress(), 77));
  assert.equal(await game.devouredExternal(await external.getAddress(), 77), true, "external marked devoured");
  assert.equal(await game.unknownCollectionDevours(await external.getAddress()), 1n, "unknown collection cap counter");
  const afterDevour = await game.getBeing(1);
  assert(afterDevour.devours > beforeDevour.devours, "devour count increased");
  assert.equal(afterDevour.power, beforeDevour.power, "unknown NFT does not directly add power");
  assert(scoreOf(afterDevour) >= scoreOf(beforeDevour), "devour mass and complexity feed hunt score");
  await assert.rejects(game.devourExternal(1, await external.getAddress(), 77));

  const reentrantArtifact = JSON.parse(fs.readFileSync("artifacts/TestReentrantExternalNFT.json", "utf8"));
  const reentrantFactory = new ethers.ContractFactory(reentrantArtifact.abi, reentrantArtifact.bytecode, alice);
  for (const mode of [1, 2, 3]) {
    const malicious = await reentrantFactory.deploy();
    await malicious.waitForDeployment();
    const maliciousTokenId = 800 + mode;
    await (await malicious.mintWithSupply(await alice.getAddress(), maliciousTokenId, 1000)).wait();
    await (await malicious.configureReentry(await game.getAddress(), 1, mode)).wait();
    await (await malicious.approve(await game.getAddress(), maliciousTokenId)).wait();
    await (await game.observeExternal(await malicious.getAddress(), maliciousTokenId)).wait();
    await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
    await (await game.devourExternal(1, await malicious.getAddress(), maliciousTokenId, { gasLimit: 1_000_000 })).wait();
    assert.equal(await malicious.attempted(), true, `malicious NFT mode ${mode} attempted reentry`);
    assert.equal(await malicious.caught(), true, `malicious NFT mode ${mode} reentry was rejected`);
    assert.equal(await malicious.ownerOf(maliciousTokenId), await game.getAddress(), `malicious NFT mode ${mode} still locked`);
    assert.equal(await game.devouredExternal(await malicious.getAddress(), maliciousTokenId), true, `malicious NFT mode ${mode} marked devoured`);
    await assert.rejects(malicious.transferFrom(await game.getAddress(), await alice.getAddress(), maliciousTokenId));
  }

  const lowSupplyExternal = await externalFactory.deploy();
  await lowSupplyExternal.waitForDeployment();
  await (await lowSupplyExternal.mint(await alice.getAddress(), 1)).wait();
  if ((await game.UNKNOWN_MIN_TOTAL_SUPPLY()) > 1n) {
    await assert.rejects(game.observeExternal(await lowSupplyExternal.getAddress(), 1));
  }

  const uri = await game.tokenURI(1);
  assert(uri.startsWith("data:application/json;base64,"), "tokenURI is base64 JSON data URI");
  const metadata = JSON.parse(Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8"));
  assert(metadata.image.startsWith("data:image/svg+xml;base64,"), "tokenURI contains base64 SVG image");
  assert(metadata.attributes.some((trait) => trait.trait_type === "LineageMask"), "tokenURI contains lineage mask trait");

  await mintBeing(game, bob, "bob-secret", 2);
  await (await game.connect(bob).transferFrom(await bob.getAddress(), await alice.getAddress(), 2)).wait();
  const beforeFuse = await game.getBeing(1);
  const sacrificeBeforeFuse = await game.getBeing(2);
  await (await game.fuseBeing(1, 2, { gasLimit: 1_000_000 })).wait();
  await assert.rejects(game.ownerOf(2));
  const afterFuse = await game.getBeing(1);
  assert(afterFuse.fusions > beforeFuse.fusions, "fusion count increased");
  assert(afterFuse.mass >= beforeFuse.mass, "fusion inherits mass");
  assert.equal(
    afterFuse.lineageMask & (beforeFuse.lineageMask | sacrificeBeforeFuse.lineageMask),
    beforeFuse.lineageMask | sacrificeBeforeFuse.lineageMask,
    "fusion inherits both lineage masks",
  );
  assert.equal(await game.aliveSupply(), 1n, "sacrifice burn reduces alive supply");

  await assert.rejects(game.fuseBeing(1, 1));

  await mintBeing(game, dave, "dave-hunt-lock-secret", 3);
  await (await game.connect(dave).transferFrom(await dave.getAddress(), await alice.getAddress(), 3)).wait();

  await (await game.approve(await bob.getAddress(), 1)).wait();
  assert.equal(await game.getApproved(1), await bob.getAddress(), "approval set before hunt");
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.getApproved(1), ethers.ZeroAddress, "approval cleared when hunt locks NFT");
  await assertTxRejects(async () => game.connect(bob).transferFrom.staticCall(await game.getAddress(), await bob.getAddress(), 1), "approved user cannot transfer hunting NFT");
  await assertTxRejects(async () => game.approve.staticCall(await bob.getAddress(), 1), "old owner cannot approve hunting NFT");
  await assertTxRejects(() => game.fuseBeing.staticCall(1, 3), "hunting parent cannot fuse");
  await assertTxRejects(() => game.fuseBeing.staticCall(3, 1), "hunting sacrifice cannot fuse");
  await assertTxRejects(async () => game.devourExternal.staticCall(1, await external.getAddress(), 78), "hunting being cannot devour");
  await assertTxRejects(async () => game.transferFrom.staticCall(await game.getAddress(), await alice.getAddress(), 1), "owner cannot pull hunting NFT directly");
  await assert.rejects(game.fuseBeing(1, 1));
  await mine(provider, 3);
  await (await game.resolveHunt(1)).wait();
  assert.equal(await game.ownerOf(3), await alice.getAddress(), "non-hunting fusion candidate remains owned");

  const receiverArtifact = JSON.parse(fs.readFileSync("artifacts/TestERC721Receiver.json", "utf8"));
  const receiverFactory = new ethers.ContractFactory(receiverArtifact.abi, receiverArtifact.bytecode, alice);
  const receiver = await receiverFactory.deploy();
  await receiver.waitForDeployment();

  await mintBeing(game, charlie, "charlie-safe-secret", 4);
  await (await game.connect(charlie)["safeTransferFrom(address,address,uint256)"](await charlie.getAddress(), await receiver.getAddress(), 4)).wait();
  assert.equal(await game.ownerOf(4), await receiver.getAddress(), "safe transfer to receiver contract works");

  const tieredExternal = await externalFactory.deploy();
  await tieredExternal.waitForDeployment();
  const tierEntries = [{ address: await tieredExternal.getAddress(), tier: 5 }];
  const tierTree = buildTree(tierEntries);
  const tieredGame = await deployGame(tierTree.root, alice.getAddress());
  assert.equal(await tieredGame.topCollectionsRoot(), tierTree.root, "tier root fixed at deploy");

  await mintBeing(tieredGame, alice, "alice-tiered-secret", 1);
  await (await tieredExternal.mint(await alice.getAddress(), 1)).wait();
  await (await tieredExternal.approve(await tieredGame.getAddress(), 1)).wait();
  const beforeTiered = await tieredGame.getBeing(1);
  assert.equal(await tieredGame.verifyCollectionTier(await tieredExternal.getAddress(), 5, proofFor(0, tierTree.layers)), true);
  assert.equal(await tieredGame.verifyCollectionTier(await tieredExternal.getAddress(), 3, proofFor(0, tierTree.layers)), false);
  await (
    await tieredGame.devourTieredExternal(
      1,
      await tieredExternal.getAddress(),
      1,
      5,
      proofFor(0, tierTree.layers),
      { gasLimit: 1_000_000 },
    )
  ).wait();
  const afterTiered = await tieredGame.getBeing(1);
  assert(afterTiered.power > beforeTiered.power, "tiered NFT increases power");
  assert.equal(await tieredExternal.ownerOf(1), await tieredGame.getAddress(), "tiered NFT locked in game");
  await assert.rejects(tieredExternal.transferFrom(await tieredGame.getAddress(), await alice.getAddress(), 1));
  await assert.rejects(tieredGame.devourTieredExternal(1, await tieredExternal.getAddress(), 1, 5, []));
  await assert.rejects(tieredGame.devourTieredExternal(1, await tieredExternal.getAddress(), 1, 6, proofFor(0, tierTree.layers)));

  const punksArtifact = JSON.parse(fs.readFileSync("artifacts/TestCryptoPunks.json", "utf8"));
  const punksFactory = new ethers.ContractFactory(punksArtifact.abi, punksArtifact.bytecode, alice);
  const punks = await punksFactory.deploy();
  await punks.waitForDeployment();
  const punkEntries = [{ address: await punks.getAddress(), tier: 5 }];
  const punkTree = buildTree(punkEntries);
  const punkGame = await deployGame(punkTree.root, alice.getAddress());
  await mintBeing(punkGame, alice, "alice-punk-secret", 1);
  await (await punks.mint(await alice.getAddress(), 123)).wait();
  await assert.rejects(punkGame.devourCryptoPunk(1, await punks.getAddress(), 123));
  await (await punkGame.observeCryptoPunk(await punks.getAddress(), 123, 5, proofFor(0, punkTree.layers))).wait();
  await mine(provider, 7201);
  await assert.rejects(punkGame.devourCryptoPunk(1, await punks.getAddress(), 123));
  await (await punkGame.observeCryptoPunk(await punks.getAddress(), 123, 5, proofFor(0, punkTree.layers))).wait();
  await assert.rejects(punkGame.devourCryptoPunk(1, await punks.getAddress(), 123));
  await (await punks.transferPunk(await punkGame.getAddress(), 123)).wait();
  const beforePunk = await punkGame.getBeing(1);
  await (await punkGame.devourCryptoPunk(1, await punks.getAddress(), 123, { gasLimit: 1_000_000 })).wait();
  assert.equal(await punks.punkIndexToAddress(123), await punkGame.getAddress(), "native punk locked in game");
  await assert.rejects(punks.transferPunk(await alice.getAddress(), 123));
  assert.equal(await punkGame.devouredExternal(await punks.getAddress(), 123), true, "punk marked devoured");
  const afterPunk = await punkGame.getBeing(1);
  assert(afterPunk.power > beforePunk.power, "punk tier increases power");

  const batchGame = await deployGame();
  await mintBeing(batchGame, alice, "batch-alice", 1);
  await mintBeing(batchGame, bob, "batch-bob", 2);
  await mintBeing(batchGame, charlie, "batch-charlie", 3);
  await mintBeing(batchGame, dave, "batch-dave", 4);
  await (await batchGame.connect(bob).approve(await alice.getAddress(), 2)).wait();
  await assert.rejects(batchGame.fuseBeing(1, 2), "approved operator cannot fuse without owning sacrifice");
  await (await batchGame.connect(bob).setApprovalForAll(await alice.getAddress(), true)).wait();
  await assert.rejects(batchGame.fuseBeing(1, 2), "approval-for-all cannot fuse without ownership");

  const batchArtifact = JSON.parse(fs.readFileSync("artifacts/TestBatchFusion.json", "utf8"));
  const batchFactory = new ethers.ContractFactory(batchArtifact.abi, batchArtifact.bytecode, alice);
  const batch = await batchFactory.deploy();
  await batch.waitForDeployment();
  for (const [signer, tokenId] of [[alice, 1], [bob, 2], [charlie, 3], [dave, 4]]) {
    await (await batchGame.connect(signer).transferFrom(await signer.getAddress(), await batch.getAddress(), tokenId)).wait();
  }
  const batchBefore = await batchGame.getBeing(1);
  await assertTxRejects(
    async () => batch.batchFuse(await batchGame.getAddress(), 1, [2, 3, 4], { gasLimit: 2_000_000 }),
    "same-block batch fusion is rejected",
  );
  assert.equal(await batchGame.ownerOf(2), await batch.getAddress(), "reverted batch keeps sacrifice 2 alive");
  assert.equal(await batchGame.ownerOf(3), await batch.getAddress(), "reverted batch keeps sacrifice 3 alive");
  assert.equal(await batchGame.ownerOf(4), await batch.getAddress(), "reverted batch keeps sacrifice 4 alive");
  for (const tokenId of [2, 3, 4]) {
    await (await batch.batchFuse(await batchGame.getAddress(), 1, [tokenId], { gasLimit: 800_000 })).wait();
  }
  const batchAfter = await batchGame.getBeing(1);
  assert.equal(await batchGame.ownerOf(1), await batch.getAddress(), "batch parent remains owned by batch contract");
  await assert.rejects(batchGame.ownerOf(2), "batch sacrifice 2 burned");
  await assert.rejects(batchGame.ownerOf(3), "batch sacrifice 3 burned");
  await assert.rejects(batchGame.ownerOf(4), "batch sacrifice 4 burned");
  assert.equal(await batchGame.aliveSupply(), 1n, "batch fusion reduces alive supply once per sacrifice");
  assert.equal(await batchGame.totalMinted(), 4n, "batch fusion does not change total minted");
  assert(batchAfter.fusions >= batchBefore.fusions + 3n, "batch fusion counts each sacrifice");

  const functionNames = artifact.abi.filter((item) => item.type === "function").map((item) => item.name);
  for (const forbiddenName of ["withdraw", "rescue", "recover", "execute", "approveExternal", "transferExternal"]) {
    assert.equal(functionNames.some((name) => name && name.toLowerCase().includes(forbiddenName.toLowerCase())), false);
  }

  assert.deepEqual(await tieredGame.nutritionForTier(1), [3n, 3n]);
  assert.deepEqual(await tieredGame.nutritionForTier(2), [6n, 12n]);
  assert.deepEqual(await tieredGame.nutritionForTier(5), [100n, 200n]);

  console.log("behavior-test ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
