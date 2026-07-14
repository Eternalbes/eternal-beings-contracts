const assert = require("assert");
const ganache = require("ganache");
const { ethers } = require("ethers");
const fs = require("fs");

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

function rng(seed) {
  let state = BigInt(seed);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number(state >> 32n);
  };
}

async function assertRejectsTx(txPromise, message) {
  await assert.rejects(async () => {
    const tx = await txPromise;
    await tx.wait();
  }, message);
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
    current = BigInt(await provider.send("eth_blockNumber", []));
    if (current > start) {
      await mineUntil(provider, start + await game.EPOCH_BLOCKS());
      epoch = await game.currentEpoch();
      start = await game.epochStart(epoch);
    }
  }
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await signer.getAddress(), epoch, secret]);
  await (await game.connect(signer).commitMint(commitment)).wait();
  await mineUntil(provider, start + commitBlocks);
  await (await game.connect(signer).revealMint(epoch, secret)).wait();
  await mineUntil(provider, start + await game.EPOCH_BLOCKS());
  await (await game.connect(signer).claimMint(epoch)).wait();
  assert.equal(await game.ownerOf(tokenId), await signer.getAddress(), `minted owner #${tokenId}`);
}

async function assertInvariants(game, ore, liveIds, burnedIds) {
  assert.equal(await game.aliveSupply(), BigInt(liveIds.length), "aliveSupply equals live token set");
  assert((await game.totalMinted()) >= (await game.aliveSupply()), "totalMinted covers aliveSupply");
  assert((await game.totalMinted()) <= (await game.MAX_BEINGS()), "totalMinted never exceeds max");
  assert((await ore.totalSupply()) <= (await game.emittedCap()), "ORE supply stays under emitted cap");
  assert((await ore.totalSupply()) <= (await game.TOKEN_MAX_SUPPLY()), "ORE supply stays under max supply");

  for (const tokenId of liveIds) {
    const owner = await game.ownerOf(tokenId);
    assert.notEqual(owner, ethers.ZeroAddress, `live token #${tokenId} has owner`);
    const being = await game.getBeing(tokenId);
    assert(being.mass > 0n, `token #${tokenId} mass stays positive`);
    assert(being.complexity > 0n, `token #${tokenId} complexity stays positive`);
    assert(being.stage <= 20n, `token #${tokenId} stage stays capped`);
    assert(being.lineageMask > 0n && being.lineageMask <= 63n, `token #${tokenId} lineage mask valid`);
    const uri = await game.tokenURI(tokenId);
    assert(uri.startsWith("data:application/json;base64,"), `token #${tokenId} has base64 JSON metadata`);
    const metadata = JSON.parse(Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8"));
    assert(metadata.image.startsWith("data:image/svg+xml;base64,"), `token #${tokenId} has base64 on-chain SVG`);
  }

  for (const tokenId of burnedIds) {
    await assert.rejects(game.ownerOf(tokenId), `burned token #${tokenId} has no owner`);
    await assert.rejects(game.getBeing(tokenId), `burned token #${tokenId} has no state`);
    await assert.rejects(game.tokenURI(tokenId), `burned token #${tokenId} has no metadata`);
  }
}

async function hunt(provider, game, signer, tokenId, blocks) {
  await (await game.connect(signer).enterHunt(tokenId, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(tokenId), await game.getAddress(), `hunt locks #${tokenId}`);
  await assert.rejects(game.connect(signer).resolveHunt.staticCall(tokenId), `hunt #${tokenId} cannot resolve in entry block`);
  await mine(provider, blocks);
  await (await game.connect(signer).resolveHunt(tokenId)).wait();
  assert.equal(await game.ownerOf(tokenId), await signer.getAddress(), `hunt returns #${tokenId}`);
}

async function main() {
  for (const artifact of [
    "artifacts/EternalBeings.json",
    "artifacts/EternalRenderer.json",
    "artifacts/EternalOre.json",
    "artifacts/TestExternalNFT.json",
  ]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));

  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const signers = await Promise.all([0, 1, 2, 3].map((index) => provider.getSigner(index)));
  const [alice, bob, charlie, dave] = signers;

  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const renderer = await rendererFactory.deploy();
  await renderer.waitForDeployment();
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const game = await gameFactory.deploy(ethers.ZeroHash, await alice.getAddress(), await renderer.getAddress());
  await game.waitForDeployment();
  const ore = new ethers.Contract(await game.ore(), oreArtifact.abi, provider);

  const liveIds = [1, 2, 3, 4];
  const burnedIds = [];
  await mintBeing(provider, game, alice, 1, "invariant-alice");
  await mintBeing(provider, game, bob, 2, "invariant-bob");
  await mintBeing(provider, game, charlie, 3, "invariant-charlie");
  await mintBeing(provider, game, dave, 4, "invariant-dave");
  await assertInvariants(game, ore, liveIds, burnedIds);

  const next = rng(0xE7E2A1n);
  for (let round = 0; round < 8; round++) {
    const tokenId = liveIds[round % liveIds.length];
    const signer = signers[tokenId - 1];
    await hunt(provider, game, signer, tokenId, 8 + (next() % 35));
    await mine(provider, Number(await game.COOLDOWN_BLOCKS()));
    await assertInvariants(game, ore, liveIds, burnedIds);
  }

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();
  await (await external.mintWithSupply(await alice.getAddress(), 9001, 1000)).wait();
  await (await external.approve(await game.getAddress(), 9001)).wait();
  await (await game.observeExternal(await external.getAddress(), 9001)).wait();
  if ((await game.UNKNOWN_HOLD_BLOCKS()) > 0n) {
    await assertRejectsTx(game.devourExternal(1, await external.getAddress(), 9001), "hold period required");
  }
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.devourExternal(1, await external.getAddress(), 9001, { gasLimit: 1_000_000 })).wait();
  assert.equal(await external.ownerOf(9001), await game.getAddress(), "devoured NFT remains locked");
  await assertInvariants(game, ore, liveIds, burnedIds);

  await (await game.connect(bob).transferFrom(await bob.getAddress(), await alice.getAddress(), 2)).wait();
  await (await game.fuseBeing(1, 2, { gasLimit: 1_000_000 })).wait();
  liveIds.splice(liveIds.indexOf(2), 1);
  burnedIds.push(2);
  await assertInvariants(game, ore, liveIds, burnedIds);

  await hunt(provider, game, alice, 1, 60);
  await assertInvariants(game, ore, liveIds, burnedIds);

  console.log("invariant-test ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
