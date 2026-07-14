const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

async function mine(provider, blocks) {
  for (let i = 0; i < blocks; i++) await provider.send("evm_mine", []);
}

async function mineUntil(provider, targetBlock) {
  const current = BigInt(await provider.send("eth_blockNumber", []));
  if (BigInt(targetBlock) > current) await mine(provider, Number(BigInt(targetBlock) - current));
}

function slotKey(tokenId, mappingSlot) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [tokenId, mappingSlot]));
}

function hex32(value) {
  return ethers.toBeHex(value, 32);
}

async function setStorage(provider, address, slot, value) {
  await provider.send("evm_setAccountStorageAt", [address, slot, hex32(value)]);
  await provider.send("evm_mine", []);
}

function packSlot0(mass, complexity) {
  return mass | (complexity << 128n);
}

function packSlot1(devours, fusions, premiumDevours, markLuck) {
  return devours | (fusions << 64n) | (premiumDevours << 128n) | (markLuck << 192n);
}

function packSlot2({ huntNonce, power, skill, scars, stage, originClass, originSymbol, mutationBias, lineageMask }) {
  return (
    huntNonce |
    (power << 64n) |
    (skill << 96n) |
    (scars << 128n) |
    (stage << 160n) |
    (originClass << 176n) |
    (originSymbol << 184n) |
    (mutationBias << 192n) |
    (lineageMask << 200n)
  );
}

async function setBeing(provider, game, tokenId, values) {
  const gameAddress = await game.getAddress();
  const base = BigInt(slotKey(tokenId, 4));
  await setStorage(provider, gameAddress, hex32(base), packSlot0(values.mass, values.complexity));
  await setStorage(provider, gameAddress, hex32(base + 1n), packSlot1(values.devours, values.fusions, values.premiumDevours, values.markLuck));
  await setStorage(provider, gameAddress, hex32(base + 2n), packSlot2(values));
  await setStorage(provider, gameAddress, hex32(base + 3n), BigInt(values.genome));
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
  const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await signer.getAddress(), epoch, secret]);
  await (await game.connect(signer).commitMint(commitment)).wait();
  await mineUntil(provider, start + commitBlocks);
  await (await game.connect(signer).revealMint(epoch, secret)).wait();
  await mineUntil(provider, start + await game.EPOCH_BLOCKS());
  await (await game.connect(signer).claimMint(epoch)).wait();
  assert.equal(await game.ownerOf(tokenId), await signer.getAddress(), `owner of #${tokenId}`);
}

async function main() {
  for (const artifact of [
    "artifacts/EternalBeings.json",
    "artifacts/EternalRenderer.json",
    "artifacts/TestExternalNFT.json",
  ]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const max128 = (1n << 128n) - 1n;
  const max64 = (1n << 64n) - 1n;
  const max32 = (1n << 32n) - 1n;

  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const [alice, bob] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);

  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const renderer = await rendererFactory.deploy();
  await renderer.waitForDeployment();
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const game = await gameFactory.deploy(ethers.ZeroHash, await alice.getAddress(), await renderer.getAddress());
  await game.waitForDeployment();

  await mintBeing(provider, game, alice, 1n, "sat-alice");
  await mintBeing(provider, game, bob, 2n, "sat-bob");
  await (await game.connect(bob).transferFrom(await bob.getAddress(), await alice.getAddress(), 2n)).wait();

  const nearMax = {
    mass: max128 - 1n,
    complexity: max128 - 1n,
    devours: max64 - 1n,
    fusions: max64 - 1n,
    premiumDevours: max64 - 1n,
    markLuck: max64,
    huntNonce: 0n,
    power: max32 - 1n,
    skill: max32 - 1n,
    scars: max32 - 1n,
    stage: 20n,
    originClass: 1n,
    originSymbol: 2n,
    mutationBias: 3n,
    lineageMask: 63n,
    genome: ethers.keccak256(ethers.toUtf8Bytes("near-max-being")),
  };
  const maxed = {
    ...nearMax,
    mass: max128,
    complexity: max128,
    devours: max64,
    fusions: max64,
    premiumDevours: max64,
    power: max32,
    skill: max32,
    scars: max32,
    genome: ethers.keccak256(ethers.toUtf8Bytes("maxed-sacrifice")),
  };

  await setBeing(provider, game, 1n, nearMax);
  await setBeing(provider, game, 2n, maxed);

  await (await game.fuseBeing(1n, 2n, { gasLimit: 1_000_000 })).wait();
  const fused = await game.getBeing(1n);
  assert.equal(fused.mass, max128, "fuse mass saturates");
  assert.equal(fused.complexity, max128, "fuse complexity saturates");
  assert.equal(fused.devours, max64, "fuse devours saturates");
  assert.equal(fused.fusions, max64, "fuse fusions saturates");
  assert.equal(fused.premiumDevours, max64, "fuse premium devours saturates");
  assert.equal(fused.power, max32, "fuse power saturates");
  assert.equal(fused.skill, max32, "fuse skill saturates");
  await assert.rejects(game.ownerOf(2n), "sacrifice burned");

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();
  await (await external.mintWithSupply(await alice.getAddress(), 77n, 1000n)).wait();
  await (await external.approve(await game.getAddress(), 77n)).wait();
  await (await game.observeExternal(await external.getAddress(), 77n)).wait();
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.devourExternal(1n, await external.getAddress(), 77n, { gasLimit: 1_000_000 })).wait();
  const devoured = await game.getBeing(1n);
  assert.equal(devoured.mass, max128, "devour mass stays saturated");
  assert.equal(devoured.complexity, max128, "devour complexity stays saturated");
  assert.equal(devoured.devours, max64, "devour count stays saturated");
  assert.equal(await external.ownerOf(77n), await game.getAddress(), "external still locks at saturation");

  await (await game.enterHunt(1n, { gasLimit: 1_000_000 })).wait();
  await mine(provider, 10);
  assert.equal(await game.ownerOf(1n), await game.getAddress(), "saturated being is locked before resolve");
  const activeHunt = await game.hunts(1n);
  assert.equal(activeHunt.owner, await alice.getAddress(), "saturated hunt owner recorded");
  await game.resolveHunt.staticCall(1n);
  await (await game.resolveHunt(1n, { gasLimit: 1_000_000 })).wait();
  const hunted = await game.getBeing(1n);
  assert.equal(hunted.power, max32, "hunt power stays saturated");
  assert.equal(hunted.skill, max32, "hunt skill stays saturated");
  assert(hunted.scars >= max32 - 1n && hunted.scars <= max32, "hunt scars stay bounded near saturation");
  assert.equal(await game.ownerOf(1n), await alice.getAddress(), "saturated being returns from hunt");

  const uri = await game.tokenURI(1n);
  assert(uri.startsWith("data:application/json;base64,"), "saturated tokenURI still renders");

  console.log("saturation-state-test ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
