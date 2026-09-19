const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function artifact(name) {
  return JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
}

async function deploy(name, signer, args = []) {
  const item = artifact(name);
  const factory = new ethers.ContractFactory(item.abi, item.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function rejects(action, message) {
  let failed = false;
  try {
    const result = await action();
    if (result && result.wait) await result.wait();
  } catch (_) {
    failed = true;
  }
  assert(failed, message);
}

function mineHookSalt(deployer, initCode) {
  const initCodeHash = ethers.keccak256(initCode);
  const requiredFlags = 0x20ccn;
  for (let candidate = 0n; candidate < 250_000n; candidate += 1n) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(candidate), 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if ((BigInt(predicted) & 0x3fffn) === requiredFlags) {
      return { salt, predicted, initCodeHash, requiredFlags };
    }
  }
  throw new Error("unable to mine StockWorldHook CREATE2 permission address");
}

async function main() {
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", allowUnlimitedContractSize: false },
    miner: { blockGasLimit: 120_000_000 },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const deployer = await provider.getSigner(0);
  const deployerAddress = await deployer.getAddress();

  const poolManager = await deploy("MockV4PoolManager", deployer);
  const permit2 = await deploy("MockV4Permit2", deployer);
  const positionManager = await deploy("MockV4PositionManager", deployer, [
    await poolManager.getAddress(),
    await permit2.getAddress(),
  ]);

  const hookDeployer = await deploy("StockWorldHookDeployer", deployer);
  await rejects(() => hookDeployer.deploy(ethers.ZeroHash, "0x"), "empty CREATE2 code is rejected");
  const hookArtifact = artifact("StockWorldHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [await poolManager.getAddress(), deployerAddress],
  );
  const hookInitCode = ethers.concat([hookArtifact.bytecode, hookArgs]);
  const mined = mineHookSalt(await hookDeployer.getAddress(), hookInitCode);
  assert.equal(
    await hookDeployer.predict(mined.salt, mined.initCodeHash),
    mined.predicted,
    "on-chain CREATE2 prediction matches the mined address",
  );
  await (await hookDeployer.deploy(mined.salt, hookInitCode, { gasLimit: 12_000_000 })).wait();
  await rejects(
    () => hookDeployer.deploy(mined.salt, hookInitCode, { gasLimit: 12_000_000 }),
    "the same CREATE2 deployment cannot be repeated",
  );
  const hook = new ethers.Contract(mined.predicted, hookArtifact.abi, deployer);
  assert.equal(await hook.hookPermissionsValid(), true, "Hook address carries the 0x20cc permission mask");

  const guard = await deploy("StockWorldGraduationGuard", deployer);
  const locker = await deploy("StockWorldLiquidityLocker", deployer, [await positionManager.getAddress()]);
  const coordinator = await deploy("StockWorldGraduationCoordinator", deployer, [
    await poolManager.getAddress(),
    await positionManager.getAddress(),
    await permit2.getAddress(),
    await hook.getAddress(),
    await guard.getAddress(),
    await locker.getAddress(),
    deployerAddress,
    0,
    60,
  ]);
  await (await hook.bindCoordinator(await coordinator.getAddress())).wait();

  const quoteRegistry = await deploy("QuoteAssetRegistry", deployer, [deployerAddress]);
  const validator = await deploy("StockWorldConfigValidator", deployer, [await quoteRegistry.getAddress()]);
  const coreDeployer = await deploy("StockWorldCoreDeployer", deployer);
  const nftDeployer = await deploy("StockWorldNftDeployer", deployer);
  const launchDeployer = await deploy("StockWorldLaunchDeployer", deployer, [
    await coreDeployer.getAddress(),
    await nftDeployer.getAddress(),
  ]);
  const factory = await deploy("StockWorldFactory", deployer, [
    await validator.getAddress(),
    await launchDeployer.getAddress(),
    await coordinator.getAddress(),
    deployerAddress,
    12,
    8,
    40,
  ]);
  await (await coordinator.bindFactory(await factory.getAddress())).wait();

  assert.equal(await hook.coordinator(), await coordinator.getAddress(), "Hook coordinator binding is final");
  assert.equal(await coordinator.factory(), await factory.getAddress(), "Coordinator factory binding is final");

  const quoteAsset = await deploy("MockQuoteAsset", deployer, ["Rehearsal USD", "rUSD", 6]);
  await (await quoteRegistry.registerQuoteAsset(await quoteAsset.getAddress())).wait();
  const launchFee = ethers.parseEther("0.0003");
  await (
    await factory.launchWorld(
      [
        "Rehearsal World",
        "RWRLD",
        await quoteAsset.getAddress(),
        deployerAddress,
        900_000_000n,
        9_999,
        4_500,
        4_500,
        1_000,
      ],
      { value: launchFee, gasLimit: 50_000_000 },
    )
  ).wait();
  const world = await factory.getWorld(0);
  for (const field of [
    "worldToken",
    "tokenRewardVault",
    "worldRewardVault",
    "bondingCurve",
    "worldNft",
    "fairMintController",
    "graduationEscrow",
  ]) {
    assert.notEqual(world[field], ethers.ZeroAddress, `${field} is deployed`);
  }
  assert.equal(await factory.worldCount(), 1n, "first World is registered");

  console.log(JSON.stringify({
    status: "stock-world-local-deployment-rehearsal-passed",
    hookCreate2: {
      deployer: await hookDeployer.getAddress(),
      salt: mined.salt,
      initCodeHash: mined.initCodeHash,
      hook: await hook.getAddress(),
      permissionMask: `0x${mined.requiredFlags.toString(16)}`,
    },
    sharedContracts: {
      hook: await hook.getAddress(),
      graduationGuard: await guard.getAddress(),
      liquidityLocker: await locker.getAddress(),
      graduationCoordinator: await coordinator.getAddress(),
      quoteAssetRegistry: await quoteRegistry.getAddress(),
      configValidator: await validator.getAddress(),
      coreDeployer: await coreDeployer.getAddress(),
      nftDeployer: await nftDeployer.getAddress(),
      launchDeployer: await launchDeployer.getAddress(),
      factory: await factory.getAddress(),
    },
    rehearsalWorld: Object.fromEntries([
      "worldToken",
      "tokenRewardVault",
      "worldRewardVault",
      "bondingCurve",
      "worldNft",
      "fairMintController",
      "graduationEscrow",
    ].map((field) => [field, world[field]])),
  }, null, 2));

  await eip1193.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
