const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

async function mine(provider, blocks) {
  for (let i = 0; i < blocks; i++) {
    await provider.send("evm_mine", []);
  }
}

async function mineUntil(provider, targetBlock) {
  const current = BigInt(await provider.send("eth_blockNumber", []));
  const target = BigInt(targetBlock);
  if (target > current) await mine(provider, Number(target - current));
}

async function assertRejects(thunk, message) {
  let rejected = false;
  try {
    const result = await thunk();
    if (result && typeof result.wait === "function") await result.wait();
  } catch (_) {
    rejected = true;
  }
  assert(rejected, message);
}

async function mintBeing(provider, game, signer, tokenId, label) {
  let epoch = await game.currentEpoch();
  let start = await game.epochStart(epoch);
  const commitBlocks = await game.COMMIT_BLOCKS();
  let current = BigInt(await provider.send("eth_blockNumber", []));

  if (current > start || current + 1n >= start + commitBlocks) {
    await mineUntil(provider, start + await game.EPOCH_BLOCKS());
    epoch = await game.currentEpoch();
    start = await game.epochStart(epoch);
  }

  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const commitment = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32"],
    [await signer.getAddress(), epoch, secret],
  );

  await (await game.connect(signer).commitMint(commitment)).wait();
  await mineUntil(provider, start + commitBlocks);
  await (await game.connect(signer).revealMint(epoch, secret)).wait();
  await mineUntil(provider, start + await game.EPOCH_BLOCKS());
  await (await game.connect(signer).claimMint(epoch)).wait();
  assert.equal(await game.ownerOf(tokenId), await signer.getAddress(), `minted #${tokenId}`);
}

async function main() {
  for (const artifact of [
    "artifacts/EternalBeings.json",
    "artifacts/EternalRenderer.json",
    "artifacts/TestExternalNFT.json",
  ]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));

  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const [alice, bob] = await Promise.all([0, 1].map((index) => provider.getSigner(index)));
  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();

  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const renderer = await rendererFactory.deploy();
  await renderer.waitForDeployment();

  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const game = await gameFactory.deploy(ethers.ZeroHash, aliceAddress, await renderer.getAddress());
  await game.waitForDeployment();
  const gameAddress = await game.getAddress();

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();
  const externalAddress = await external.getAddress();

  await mintBeing(provider, game, alice, 1, "external-abuse-alice");
  await mintBeing(provider, game, bob, 2, "external-abuse-bob");

  await (await external.mintWithSupply(aliceAddress, 100, 1000)).wait();
  await (await game.observeExternal(externalAddress, 100)).wait();
  await (await external.transferFrom(aliceAddress, bobAddress, 100)).wait();
  await (await external.connect(bob).approve(gameAddress, 100)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await assertRejects(() => game.devourExternal.staticCall(1, externalAddress, 100), "old observer cannot devour after transfer");
  await assertRejects(
    () => game.connect(bob).devourExternal.staticCall(2, externalAddress, 100),
    "new owner cannot reuse old observation",
  );

  await (await game.connect(bob).observeExternal(externalAddress, 100)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.connect(bob).devourExternal(2, externalAddress, 100, { gasLimit: 1_000_000 })).wait();
  assert.equal(await external.ownerOf(100), gameAddress, "new owner can devour only after observing");
  assert.equal(await game.devouredExternal(externalAddress, 100), true, "observed transfer token marked devoured after valid devour");

  await (await external.mintWithSupply(aliceAddress, 101, 1001)).wait();
  await (await external.transferFrom(aliceAddress, gameAddress, 101)).wait();
  assert.equal(await external.ownerOf(101), gameAddress, "direct transfer to game locks external token");
  assert.equal(await game.devouredExternal(externalAddress, 101), false, "direct transfer is not counted as devoured");
  await assertRejects(() => game.devourExternal.staticCall(1, externalAddress, 101), "directly transferred NFT cannot be claimed as devour");
  await assertRejects(() => external.transferFrom(gameAddress, aliceAddress, 101), "directly transferred NFT cannot be pulled back");

  console.log("external NFT abuse test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
