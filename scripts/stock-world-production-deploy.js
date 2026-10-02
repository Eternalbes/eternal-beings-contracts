const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { loadBuild, assertBuild, verifyDeployment } = require("./deployment-build");
const { installGasGuard } = require("./stock-world-mainnet-gas-guard");

const DEFAULT_CONFIG = "config/stock-world.production.json";
const DEFAULT_SECRET = "reports/secrets/deployer.secrets.json";
const DEFAULT_OUTPUT = "reports/deployment-stock-world-mainnet.json";
const REQUIRED_HOOK_FLAGS = 0x20ccn;
const DEPLOYMENT_SCHEMA_VERSION = 5;

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG,
    secretPath: DEFAULT_SECRET,
    outputPath: DEFAULT_OUTPUT,
    siteConfigPath: "",
    broadcast: false,
    confirm: "",
    maxTotalGasEth: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.configPath = argv[++i];
    else if (arg === "--secret") args.secretPath = argv[++i];
    else if (arg === "--output") args.outputPath = argv[++i];
    else if (arg === "--site-config") args.siteConfigPath = argv[++i];
    else if (arg === "--confirm") args.confirm = argv[++i];
    else if (arg === "--broadcast") args.broadcast = true;
    else if (arg === "--max-total-gas-eth") args.maxTotalGasEth = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function isIgnored(path) {
  return spawnSync("git", ["check-ignore", "-q", path], { cwd: process.cwd() }).status === 0;
}

function privateKeyFor(secretReport, address) {
  const expected = address.toLowerCase();
  const entry = (secretReport.wallets || []).find(
    (wallet) => String(wallet.address).toLowerCase() === expected,
  );
  if (!entry?.privateKey) throw new Error(`missing private key for ${address}`);
  return entry.privateKey;
}

function runReadiness(configPath) {
  const result = spawnSync(
    process.execPath,
    ["scripts/stock-world-production-readiness.js", configPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error("production readiness is blocked");
  return JSON.parse(result.stdout);
}

function mineHookSalt(deployer, initCode) {
  const initCodeHash = ethers.keccak256(initCode);
  for (let candidate = 0n; candidate < 250_000n; candidate += 1n) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(candidate), 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if ((BigInt(predicted) & 0x3fffn) === REQUIRED_HOOK_FLAGS) {
      return { salt, predicted, initCodeHash };
    }
  }
  throw new Error("unable to mine StockWorldHook CREATE2 permission address");
}

function initialReport(configPath, configHash, config, readiness) {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "deploying",
    configPath,
    configHash,
    chainId: String(config.chainId),
    deployer: ethers.getAddress(config.deployer),
    readinessCheckedAt: readiness.checkedAt,
    contracts: {},
    transactions: [],
    quoteAssets: [],
  };
}

function writeSiteConfig(siteConfigPath, config, report) {
  if (!siteConfigPath) return;
  if (!fs.existsSync(siteConfigPath)) throw new Error(`missing site config: ${siteConfigPath}`);
  const siteConfig = readJson(siteConfigPath);
  if (siteConfig.chainId && String(siteConfig.chainId) !== String(config.chainId)) {
    throw new Error(`site config chainId ${siteConfig.chainId} does not match ${config.chainId}`);
  }
  const factoryAddress = report.contracts.factory?.address;
  if (!factoryAddress || !report.factoryDeploymentBlock) {
    throw new Error("deployment report is missing the Factory address or deployment block");
  }
  siteConfig.chainId = Number(config.chainId);
  siteConfig.chainName = siteConfig.chainName || "Robinhood Chain";
  siteConfig.rpcUrl = config.rpcUrl;
  siteConfig.explorerUrl = config.explorerUrl;
  siteConfig.nativeCurrency = siteConfig.nativeCurrency || { name: "Ether", symbol: "ETH", decimals: 18 };
  siteConfig.factoryAddress = ethers.getAddress(factoryAddress);
  siteConfig.factoryDeploymentBlock = Number(report.factoryDeploymentBlock);
  siteConfig.quoteAssets = config.quoteAssets.map((entry) => ({ address: ethers.getAddress(entry.address) }));
  const serialized = `${JSON.stringify(siteConfig, null, 2)}\n`;
  fs.mkdirSync(path.dirname(siteConfigPath), { recursive: true });
  fs.writeFileSync(siteConfigPath, serialized);
  report.siteConfigPath = siteConfigPath;
  report.siteConfigHash = ethers.keccak256(ethers.toUtf8Bytes(serialized));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = runReadiness(args.configPath);
  if (!args.broadcast) {
    console.log(JSON.stringify({
      status: "plan-only-ready",
      next: `npm run stock-world:production-deploy -- --broadcast --confirm DEPLOY-STOCK-WORLD-${readiness.chainId} --max-total-gas-eth <approved-ETH-budget>`,
    }, null, 2));
    return;
  }

  const expectedConfirmation = `DEPLOY-STOCK-WORLD-${readiness.chainId}`;
  if (args.confirm !== expectedConfirmation) {
    throw new Error(`broadcast requires --confirm ${expectedConfirmation}`);
  }
  if (!args.maxTotalGasEth || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(args.maxTotalGasEth)) {
    throw new Error("broadcast requires --max-total-gas-eth with the explicitly approved Gas budget");
  }
  const gasBudgetWei = ethers.parseEther(args.maxTotalGasEth);
  if (gasBudgetWei <= 0n) throw new Error("deployment Gas budget must be positive");
  if (!isIgnored(args.secretPath)) {
    throw new Error(`secret path is not ignored by git: ${args.secretPath}`);
  }
  if (!isIgnored(args.outputPath)) {
    throw new Error(`deployment report path is not ignored by git: ${args.outputPath}`);
  }

  const configText = fs.readFileSync(args.configPath, "utf8");
  const config = JSON.parse(configText);
  const configHash = ethers.keccak256(ethers.toUtf8Bytes(configText));
  const secrets = readJson(args.secretPath);
  const rawWallet = new ethers.Wallet(privateKeyFor(secrets, config.deployer));
  if (rawWallet.address.toLowerCase() !== config.deployer.toLowerCase()) {
    throw new Error(`private key resolves to ${rawWallet.address}, expected ${config.deployer}`);
  }

  const build = loadBuild([
    "StockWorldHookDeployer",
    "StockWorldHook",
    "StockWorldGraduationGuard",
    "StockWorldLiquidityLocker",
    "StockWorldGraduationCoordinator",
    "QuoteAssetRegistry",
    "StockWorldConfigValidator",
    "StockWorldCoreDeployer",
    "StockWorldRenderer",
    "StockWorldNftDeployer",
    "StockWorldLaunchDeployer",
    "StockWorldFactory",
  ]);

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: false, cacheTimeout: -1 });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(`wrong chain: expected ${config.chainId}, received ${network.chainId}`);
  }
  const signer = new ethers.NonceManager(rawWallet.connect(provider));

  let report;
  if (fs.existsSync(args.outputPath)) {
    report = readJson(args.outputPath);
    if (report.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION) {
      throw new Error(`deployment report schema ${report.schemaVersion || 1} cannot resume build-bound schema ${DEPLOYMENT_SCHEMA_VERSION}; use a new output path`);
    }
    assertBuild(report, build.buildId);
    if (report.configHash !== configHash) {
      throw new Error("existing deployment report belongs to a different production manifest");
    }
    if (String(report.chainId) !== String(config.chainId)) {
      throw new Error("existing deployment report belongs to a different chain");
    }
  } else {
    report = initialReport(args.configPath, configHash, config, readiness);
    report.buildId = build.buildId;
  }

  function checkpoint() {
    report.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  let currentActionLabel = "";
  installGasGuard(provider, config, report, checkpoint, gasBudgetWei, () => currentActionLabel);

  async function codeExists(address) {
    return address && await provider.getCode(address) !== "0x";
  }

  async function deploy(key, name, constructorArgs = []) {
    const item = build.artifacts[name];
    const factory = new ethers.ContractFactory(item.abi, item.bytecode, signer);
    const initCode = (await factory.getDeployTransaction(...constructorArgs)).data;
    let saved = report.contracts[key];
    if (!saved) {
      const guarded = report.gasGuardTransactions.find((entry) => entry.label === `deploy:${key}`);
      if (guarded) {
        if (guarded.to !== null || guarded.dataHash !== ethers.keccak256(initCode)) throw new Error("guarded deployment build mismatch");
        saved = report.contracts[key] = { contractName: name, address: guarded.predictedAddress,
          transactionHash: guarded.hash, initCodeHash: guarded.dataHash, status: "pending" };
        checkpoint();
      }
    }
    if (saved?.address) {
      const { receipt, runtimeCodeHash } = await verifyDeployment(provider, saved, initCode, rawWallet.address);
      saved.status = "mined";
      saved.blockNumber = receipt.blockNumber;
      saved.gasUsed = receipt.gasUsed.toString();
      saved.runtimeCodeHash = runtimeCodeHash;
      if (!report.transactions.some((entry) => entry.hash === receipt.hash)) {
        report.transactions.push({ label: `deploy:${key}`, hash: receipt.hash, status: "mined",
          blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
      }
      checkpoint();
      return new ethers.Contract(saved.address, item.abi, signer);
    }

    currentActionLabel = `deploy:${key}`;
    const contract = await factory.deploy(...constructorArgs);
    const transaction = contract.deploymentTransaction();
    report.contracts[key] = {
      contractName: name,
      address: await contract.getAddress(),
      transactionHash: transaction.hash,
      initCodeHash: ethers.keccak256(initCode),
      status: "pending",
    };
    checkpoint();
    const receipt = await transaction.wait();
    if (receipt.status !== 1) throw new Error(`${key} deployment failed`);
    report.contracts[key] = {
      ...report.contracts[key],
      status: "mined",
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      runtimeCodeHash: ethers.keccak256(await provider.getCode(await contract.getAddress())),
    };
    report.transactions.push({
      label: `deploy:${key}`,
      hash: receipt.hash,
      status: "mined",
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
    checkpoint();
    return contract;
  }

  async function transact(label, action) {
    let existing = report.transactions.find((entry) => entry.label === label && entry.status !== "failed");
    if (!existing) {
      const guarded = report.gasGuardTransactions.find((entry) => entry.label === label && entry.status !== "failed");
      if (guarded) {
        existing = { label, hash: guarded.hash, status: "pending" };
        report.transactions.push(existing); checkpoint();
      }
    }
    if (existing) {
      const receipt = await provider.waitForTransaction(existing.hash, 1, 120_000);
      if (!receipt || receipt.status !== 1) throw new Error(`${label} checkpoint did not confirm`);
      existing.status = "mined";
      existing.blockNumber = receipt.blockNumber;
      existing.gasUsed = receipt.gasUsed.toString();
      checkpoint();
      return;
    }
    currentActionLabel = label;
    const tx = await action();
    const entry = { label, hash: tx.hash, status: "pending" };
    report.transactions.push(entry);
    checkpoint();
    const receipt = await tx.wait();
    entry.status = receipt.status === 1 ? "mined" : "failed";
    entry.blockNumber = receipt.blockNumber;
    entry.gasUsed = receipt.gasUsed.toString();
    checkpoint();
    if (receipt.status !== 1) throw new Error(`${label} failed`);
  }

  const deployerAddress = ethers.getAddress(config.deployer);
  const hookDeployer = await deploy("hookDeployer", "StockWorldHookDeployer");
  const hookArtifact = build.artifacts.StockWorldHook;
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [config.v4.poolManager, deployerAddress],
  );
  const hookInitCode = ethers.concat([hookArtifact.bytecode, hookArgs]);
  const minedHook = mineHookSalt(await hookDeployer.getAddress(), hookInitCode);
  if (report.contracts.hook?.address && report.contracts.hook.address !== minedHook.predicted) {
    throw new Error("checkpointed Hook address differs from the deterministic prediction");
  }
  if (!(await codeExists(minedHook.predicted))) {
    await transact("create2:hook", () =>
      hookDeployer.deploy(minedHook.salt, hookInitCode, { gasLimit: 12_000_000 })
    );
  }
  const hookRuntimeCodeHash = ethers.keccak256(await provider.getCode(minedHook.predicted));
  if (report.contracts.hook?.runtimeCodeHash && report.contracts.hook.runtimeCodeHash !== hookRuntimeCodeHash) {
    throw new Error("checkpointed Hook runtime code mismatch");
  }
  report.contracts.hook = {
    contractName: "StockWorldHook",
    address: minedHook.predicted,
    status: "mined",
    salt: minedHook.salt,
    initCodeHash: minedHook.initCodeHash,
    runtimeCodeHash: hookRuntimeCodeHash,
  };
  checkpoint();
  const hook = new ethers.Contract(minedHook.predicted, hookArtifact.abi, signer);

  const guard = await deploy("graduationGuard", "StockWorldGraduationGuard");
  const locker = await deploy("liquidityLocker", "StockWorldLiquidityLocker", [config.v4.positionManager]);
  const coordinator = await deploy("graduationCoordinator", "StockWorldGraduationCoordinator", [
    config.v4.poolManager,
    config.v4.positionManager,
    config.v4.permit2,
    await hook.getAddress(),
    await guard.getAddress(),
    await locker.getAddress(),
    deployerAddress,
    config.permanentMarket.poolFee,
    config.permanentMarket.tickSpacing,
  ]);
  if (await hook.coordinator() === ethers.ZeroAddress) {
    await transact("bind:hook.coordinator", async () => hook.bindCoordinator(await coordinator.getAddress()));
  }

  const quoteRegistry = await deploy("quoteAssetRegistry", "QuoteAssetRegistry", [config.quoteAssetAuthority]);
  const validator = await deploy("configValidator", "StockWorldConfigValidator", [await quoteRegistry.getAddress()]);
  const coreDeployer = await deploy("coreDeployer", "StockWorldCoreDeployer");
  const renderer = await deploy("renderer", "StockWorldRenderer");
  const nftDeployer = await deploy("nftDeployer", "StockWorldNftDeployer", [await renderer.getAddress()]);
  const launchDeployer = await deploy("launchDeployer", "StockWorldLaunchDeployer", [
    await coreDeployer.getAddress(),
    await nftDeployer.getAddress(),
  ]);
  const factory = await deploy("factory", "StockWorldFactory", [
    await validator.getAddress(),
    await launchDeployer.getAddress(),
    await coordinator.getAddress(),
    config.platformFeeRecipient,
  ]);
  if (await coordinator.factory() === ethers.ZeroAddress) {
    await transact("bind:coordinator.factory", async () => coordinator.bindFactory(await factory.getAddress()));
  }

  const authorityIsDeployer = config.quoteAssetAuthority.toLowerCase() === deployerAddress.toLowerCase();
  function recordQuoteAsset(entry) {
    const index = report.quoteAssets.findIndex(
      (saved) => saved.address.toLowerCase() === entry.address.toLowerCase(),
    );
    if (index === -1) report.quoteAssets.push(entry);
    else report.quoteAssets[index] = entry;
  }
  for (const entry of config.quoteAssets) {
    const asset = ethers.getAddress(entry.address);
    const quoteContract = new ethers.Contract(
      asset,
      ["function decimals() view returns (uint8)"],
      signer,
    );
    const decimals = Number(await quoteContract.decimals());
    const phantomQuote = ethers.parseUnits(entry.phantomQuote, decimals);
    const graduationThreshold = ethers.parseUnits(entry.graduationThreshold, decimals);
    const info = await quoteRegistry.getQuoteAsset(asset);
    if (info.registered) {
      if (info.phantomQuote !== phantomQuote || info.graduationThreshold !== graduationThreshold) {
        throw new Error(`registered graduation economics mismatch for ${asset}`);
      }
      recordQuoteAsset({
        address: asset,
        status: info.enabled ? "enabled" : "disabled",
        phantomQuote: phantomQuote.toString(),
        graduationThreshold: graduationThreshold.toString(),
      });
      continue;
    }
    if (authorityIsDeployer) {
      await transact(`register:quoteAsset:${asset}`, () =>
        quoteRegistry.registerQuoteAsset(asset, phantomQuote, graduationThreshold)
      );
      recordQuoteAsset({
        address: asset,
        status: "enabled",
        phantomQuote: phantomQuote.toString(),
        graduationThreshold: graduationThreshold.toString(),
      });
    } else {
      recordQuoteAsset({
        address: asset,
        status: "awaiting-authority",
        phantomQuote: phantomQuote.toString(),
        graduationThreshold: graduationThreshold.toString(),
        calldata: quoteRegistry.interface.encodeFunctionData("registerQuoteAsset", [
          asset,
          phantomQuote,
          graduationThreshold,
        ]),
      });
    }
    checkpoint();
  }

  async function assertAddress(label, actualPromise, expected) {
    const actual = await actualPromise;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
    }
  }

  if (!(await hook.hookPermissionsValid())) throw new Error("Hook permission bits are invalid");
  await assertAddress("Hook.poolManager", hook.poolManager(), config.v4.poolManager);
  await assertAddress("Hook.coordinatorBinder", hook.coordinatorBinder(), deployerAddress);
  await assertAddress("Hook.coordinator", hook.coordinator(), await coordinator.getAddress());
  await assertAddress("Locker.positionManager", locker.positionManager(), config.v4.positionManager);
  await assertAddress("Coordinator.poolManager", coordinator.poolManager(), config.v4.poolManager);
  await assertAddress("Coordinator.positionManager", coordinator.positionManager(), config.v4.positionManager);
  await assertAddress("Coordinator.permit2", coordinator.permit2(), config.v4.permit2);
  await assertAddress("Coordinator.worldHook", coordinator.worldHook(), await hook.getAddress());
  await assertAddress("Coordinator.graduationGuard", coordinator.graduationGuard(), await guard.getAddress());
  await assertAddress("Coordinator.locker", coordinator.locker(), await locker.getAddress());
  await assertAddress("Coordinator.factoryBinder", coordinator.factoryBinder(), deployerAddress);
  await assertAddress("Coordinator.factory", coordinator.factory(), await factory.getAddress());
  if (Number(await coordinator.poolFee()) !== config.permanentMarket.poolFee) {
    throw new Error("Coordinator.poolFee mismatch");
  }
  if (Number(await coordinator.tickSpacing()) !== config.permanentMarket.tickSpacing) {
    throw new Error("Coordinator.tickSpacing mismatch");
  }
  await assertAddress("Registry.authority", quoteRegistry.authority(), config.quoteAssetAuthority);
  const nativeEconomics = await quoteRegistry.economicsOf(ethers.ZeroAddress);
  if (
    nativeEconomics.phantomQuote !== ethers.parseEther("1.68")
      || nativeEconomics.graduationThreshold !== ethers.parseEther("4.2")
  ) throw new Error("Registry native ETH graduation economics mismatch");
  await assertAddress("Validator.quoteAssetRegistry", validator.quoteAssetRegistry(), await quoteRegistry.getAddress());
  await assertAddress("NftDeployer.renderer", nftDeployer.renderer(), await renderer.getAddress());
  await assertAddress("LaunchDeployer.coreDeployer", launchDeployer.coreDeployer(), await coreDeployer.getAddress());
  await assertAddress("LaunchDeployer.nftDeployer", launchDeployer.nftDeployer(), await nftDeployer.getAddress());
  await assertAddress("Factory.configValidator", factory.configValidator(), await validator.getAddress());
  await assertAddress("Factory.launchDeployer", factory.launchDeployer(), await launchDeployer.getAddress());
  await assertAddress("Factory.graduationCoordinator", factory.graduationCoordinator(), await coordinator.getAddress());
  await assertAddress("Factory.platformFeeRecipient", factory.platformFeeRecipient(), config.platformFeeRecipient);
  report.status = authorityIsDeployer ? "deployed" : "awaiting-quote-asset-authority";
  report.factoryDeploymentBlock = report.contracts.factory.blockNumber;
  writeSiteConfig(args.siteConfigPath, config, report);
  checkpoint();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
