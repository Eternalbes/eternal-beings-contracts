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
  const [alice, bob, charlie] = await Promise.all([0, 1, 2].map((index) => provider.getSigner(index)));

  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const renderer = await rendererFactory.deploy();
  await renderer.waitForDeployment();

  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const game = await gameFactory.deploy(ethers.ZeroHash, await alice.getAddress(), await renderer.getAddress());
  await game.waitForDeployment();

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();

  await mintBeing(provider, game, alice, 1, "hunt-abuse-alice-1");
  await mintBeing(provider, game, bob, 2, "hunt-abuse-bob-2");
  await mintBeing(provider, game, charlie, 3, "hunt-abuse-charlie-3");
  await (await game.connect(bob).transferFrom(await bob.getAddress(), await alice.getAddress(), 2)).wait();
  await (await game.connect(charlie).transferFrom(await charlie.getAddress(), await alice.getAddress(), 3)).wait();
  await (await external.mint(await alice.getAddress(), 77)).wait();
  await (await external.approve(await game.getAddress(), 77)).wait();

  await assertRejects(() => game.resolveHunt.staticCall(1), "cannot resolve a token that never entered hunt");
  await assertRejects(() => game.connect(bob).enterHunt.staticCall(1), "non-owner cannot enter hunt");

  await (await game.approve(await bob.getAddress(), 1)).wait();
  await (await game.setApprovalForAll(await charlie.getAddress(), true)).wait();
  await assertRejects(() => game.connect(bob).enterHunt.staticCall(1), "approved address cannot enter hunt");
  await assertRejects(() => game.connect(charlie).enterHunt.staticCall(1), "operator cannot enter hunt");

  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(1), await game.getAddress(), "hunt escrows token");
  assert.equal(await game.getApproved(1), ethers.ZeroAddress, "hunt clears token approval");
  assert.equal((await game.hunts(1)).owner, await alice.getAddress(), "hunt remembers original hunter");

  await assertRejects(() => game.resolveHunt.staticCall(1), "same-block resolve is blocked");
  await assertRejects(() => game.enterHunt.staticCall(1), "cannot enter twice while escrowed");
  await assertRejects(() => game.connect(bob).resolveHunt.staticCall(1), "non-hunter cannot resolve");
  await assertRejects(
    async () => game.transferFrom.staticCall(await game.getAddress(), await alice.getAddress(), 1),
    "hunter cannot pull escrowed token",
  );
  await assertRejects(
    async () => game.connect(bob).transferFrom.staticCall(await game.getAddress(), await bob.getAddress(), 1),
    "old approved address cannot move escrowed token",
  );
  await assertRejects(
    async () => game.connect(charlie).transferFrom.staticCall(await game.getAddress(), await charlie.getAddress(), 1),
    "old operator cannot move escrowed token",
  );
  await assertRejects(async () => game.approve.staticCall(await bob.getAddress(), 1), "hunter cannot approve escrowed token");
  await assertRejects(() => game.fuseBeing.staticCall(1, 2), "hunting parent cannot fuse");
  await assertRejects(() => game.fuseBeing.staticCall(2, 1), "hunting sacrifice cannot fuse");
  await assertRejects(
    async () => game.devourExternal.staticCall(1, await external.getAddress(), 77),
    "hunting token cannot devour external NFT",
  );

  await mine(provider, 2);
  await (await game.resolveHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(1), await alice.getAddress(), "resolve returns token");
  assert.equal((await game.hunts(1)).owner, ethers.ZeroAddress, "hunt state is cleared");
  await assertRejects(() => game.enterHunt.staticCall(1), "cooldown blocks immediate re-entry");

  await mineUntil(provider, await game.cooldownUntil(1));
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  await mine(provider, 1);
  await (await game.resolveHunt(1, { gasLimit: 1_000_000 })).wait();

  await (await game.fuseBeing(2, 3, { gasLimit: 1_000_000 })).wait();
  await assertRejects(() => game.resolveHunt.staticCall(3), "burned token cannot be resolved as hunt");

  const ore = new ethers.Contract(await game.ore(), ["function totalSupply() view returns (uint256)"], provider);
  assert((await ore.totalSupply()) <= (await game.emittedCap()), "ORE remains under block emission cap");
  assert((await ore.totalSupply()) <= (await game.TOKEN_MAX_SUPPLY()), "ORE remains under max supply");

  console.log("hunt abuse test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
