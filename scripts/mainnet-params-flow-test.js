const assert = require("assert");
const fs = require("fs");
const { spawnSync } = require("child_process");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { buildTree, proofFor } = require("./merkle");

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${process.execPath} ${args.join(" ")} failed`);
}

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

async function deployGame(alice, rendererArtifact, gameArtifact, root = ethers.ZeroHash) {
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, alice);
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, alice);
  const renderer = await rendererFactory.deploy();
  await renderer.waitForDeployment();
  const game = await gameFactory.deploy(root, await alice.getAddress(), await renderer.getAddress());
  await game.waitForDeployment();
  return game;
}

async function mintBeing(provider, game, signer, tokenId) {
  const epoch = await game.currentEpoch();
  const start = await game.epochStart(epoch);
  const secret = ethers.keccak256(ethers.toUtf8Bytes(`mainnet-flow-${tokenId}`));
  const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [await signer.getAddress(), epoch, secret]);

  await (await game.connect(signer).commitMint(commitment)).wait();
  await assertRejects(() => game.connect(signer).revealMint.staticCall(epoch, secret), "cannot reveal before mainnet commit phase ends");
  await mineUntil(provider, start + await game.COMMIT_BLOCKS());
  await (await game.connect(signer).revealMint(epoch, secret)).wait();
  await assertRejects(() => game.connect(signer).claimMint.staticCall(epoch), "cannot claim before full mainnet epoch ends");
  await mineUntil(provider, start + await game.EPOCH_BLOCKS());
  await (await game.connect(signer).claimMint(epoch)).wait();
  assert.equal(await game.ownerOf(tokenId), await signer.getAddress(), `minted #${tokenId}`);
}

async function runMainnetFlow() {
  const mainnetParams = JSON.parse(fs.readFileSync("config/contract-params.mainnet.json", "utf8")).constants;
  for (const artifact of ["artifacts/EternalBeings.json", "artifacts/EternalRenderer.json", "artifacts/TestExternalNFT.json"]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [alice, bob] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const externalArtifact = JSON.parse(fs.readFileSync("artifacts/TestExternalNFT.json", "utf8"));
  const game = await deployGame(alice, rendererArtifact, gameArtifact);
  const aliceAddress = await alice.getAddress();
  const gameAddress = await game.getAddress();

  const constants = {
    EPOCH_BLOCKS: await game.EPOCH_BLOCKS(),
    COMMIT_BLOCKS: await game.COMMIT_BLOCKS(),
    MINTS_PER_EPOCH: await game.MINTS_PER_EPOCH(),
    MAX_ENDURANCE: await game.MAX_ENDURANCE(),
    COOLDOWN_BLOCKS: await game.COOLDOWN_BLOCKS(),
    UNKNOWN_HOLD_BLOCKS: await game.UNKNOWN_HOLD_BLOCKS(),
    CRYPTOPUNK_OBSERVATION_BLOCKS: await game.CRYPTOPUNK_OBSERVATION_BLOCKS(),
    UNKNOWN_MIN_TOTAL_SUPPLY: await game.UNKNOWN_MIN_TOTAL_SUPPLY(),
    UNKNOWN_COLLECTION_DEVOUR_LIMIT: await game.UNKNOWN_COLLECTION_DEVOUR_LIMIT(),
    ROYALTY_BPS: await game.ROYALTY_BPS(),
  };
  for (const [name, value] of Object.entries(constants)) {
    assert.equal(value, BigInt(mainnetParams[name]), `${name} matches mainnet config`);
  }

  await mintBeing(provider, game, alice, 1n);
  await mintBeing(provider, game, bob, 2n);

  const externalFactory = new ethers.ContractFactory(externalArtifact.abi, externalArtifact.bytecode, alice);
  const external = await externalFactory.deploy();
  await external.waitForDeployment();
  const externalAddress = await external.getAddress();
  await (await external.mintWithSupply(aliceAddress, 77, BigInt(mainnetParams.UNKNOWN_MIN_TOTAL_SUPPLY))).wait();
  await (await external.approve(gameAddress, 77)).wait();
  await (await game.observeExternal(externalAddress, 77)).wait();
  await assertRejects(() => game.devourExternal(1, externalAddress, 77), "mainnet unknown NFT hold blocks enforced");
  await mine(provider, Number(await game.UNKNOWN_HOLD_BLOCKS()));
  await (await game.devourExternal(1, externalAddress, 77, { gasLimit: 1_000_000 })).wait();
  assert.equal(await external.ownerOf(77), gameAddress, "mainnet unknown NFT locked after hold");

  const devourBlock = BigInt(await provider.send("eth_blockNumber", []));
  const devourCooldown = await game.cooldownUntil(1);
  assert(devourCooldown <= devourBlock + 1n, "devour only applies same-block evolution guard");
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  const hunt = await game.hunts(1);
  assert.equal(await game.ownerOf(1), gameAddress, "mainnet hunt locks NFT");
  assert(hunt.endurance <= constants.MAX_ENDURANCE, "mainnet endurance cap respected");
  await mine(provider, 80);
  await (await game.resolveHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(1), aliceAddress, "mainnet hunt resolves NFT");
  await assertRejects(() => game.enterHunt(1), "mainnet hunt cooldown blocks immediate re-entry after resolve");
  await mine(provider, Number(await game.COOLDOWN_BLOCKS()));
  await (await game.enterHunt(1, { gasLimit: 1_000_000 })).wait();
  assert.equal(await game.ownerOf(1), gameAddress, "mainnet hunt can re-enter after cooldown");

  const entries = [{ address: externalAddress, tier: 5 }];
  const tree = buildTree(entries);
  const tieredGame = await deployGame(alice, rendererArtifact, gameArtifact, tree.root);
  const tieredGameAddress = await tieredGame.getAddress();
  await mintBeing(provider, tieredGame, alice, 1n);
  await (await external.mintWithSupply(aliceAddress, 88, BigInt(mainnetParams.UNKNOWN_MIN_TOTAL_SUPPLY) + 1n)).wait();
  await (await external.approve(tieredGameAddress, 88)).wait();
  const proof = proofFor(0, tree.layers);
  assert.equal(await tieredGame.verifyCollectionTier(externalAddress, 5, proof), true, "mainnet tier proof verifies");
  await (await tieredGame.devourTieredExternal(1, externalAddress, 88, 5, proof, { gasLimit: 1_000_000 })).wait();
  const tieredBeing = await tieredGame.getBeing(1);
  assert.equal(tieredBeing.premiumDevours, 1n, "mainnet tiered devour increments premium devours");

  const ore = new ethers.Contract(await game.ore(), JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8")).abi, provider);
  assert((await ore.totalSupply()) <= await game.emittedCap(), "mainnet ORE supply within emission cap");

  console.log(
    JSON.stringify(
      {
        status: "mainnet-params-flow-test ok",
        constants: Object.fromEntries(Object.entries(constants).map(([key, value]) => [key, value.toString()])),
        minted: (await game.totalMinted()).toString(),
        aliveSupply: (await game.aliveSupply()).toString(),
        oreTotalSupply: (await ore.totalSupply()).toString(),
        emittedCap: (await game.emittedCap()).toString(),
      },
      null,
      2,
    ),
  );
}

async function main() {
  let appliedMainnet = false;
  try {
    runNode(["scripts/apply-contract-params.js", "mainnet"]);
    appliedMainnet = true;
    runNode(["scripts/compile.js"], { WRITE_ARTIFACTS: "1" });
    await runMainnetFlow();
  } finally {
    if (appliedMainnet) {
      runNode(["scripts/apply-contract-params.js", "testnet-fast"]);
      runNode(["scripts/compile.js"], { WRITE_ARTIFACTS: "1" });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
