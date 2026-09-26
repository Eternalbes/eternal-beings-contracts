const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const DEFAULT_CONFIG = "config/stock-world.testnet.json";
const DEFAULT_SECRET = "reports/secrets/deployer.secrets.json";
const DEFAULT_OUTPUT = "reports/deployment-stock-world-testnet-three-step-v5.json";
const DEFAULT_SITE_CONFIG = "../eternalbes-site/stock-world/config.json";
const REQUIRED_HOOK_FLAGS = 0x20ccn;
const REPORT_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG,
    secretPath: DEFAULT_SECRET,
    outputPath: DEFAULT_OUTPUT,
    siteConfigPath: DEFAULT_SITE_CONFIG,
    broadcast: false,
    confirm: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.configPath = argv[++i];
    else if (arg === "--secret") args.secretPath = argv[++i];
    else if (arg === "--output") args.outputPath = argv[++i];
    else if (arg === "--site-config") args.siteConfigPath = argv[++i];
    else if (arg === "--confirm") args.confirm = argv[++i];
    else if (arg === "--broadcast") args.broadcast = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function artifact(name) {
  return readJson(`artifacts/${name}.json`);
}

function isIgnored(filePath) {
  return spawnSync("git", ["check-ignore", "-q", filePath], { cwd: process.cwd() }).status === 0;
}

function privateKeyFor(secretReport, address) {
  const expected = address.toLowerCase();
  const entry = (secretReport.wallets || []).find(
    (wallet) => String(wallet.address).toLowerCase() === expected,
  );
  if (!entry?.privateKey) throw new Error(`missing private key for ${address}`);
  return entry.privateKey;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(args.configPath);
  if (config.status !== "approved-for-testnet-deployment") {
    throw new Error("testnet config is not approved for deployment");
  }
  if (Number(config.chainId) !== 46630) throw new Error("testnet deployer only permits chain 46630");
  if (!args.broadcast) {
    console.log(JSON.stringify({
      status: "plan-only-ready",
      chainId: config.chainId,
      next: "npm run stock-world:testnet-deploy -- --broadcast --confirm DEPLOY-STOCK-WORLD-46630",
    }, null, 2));
    return;
  }
  if (args.confirm !== "DEPLOY-STOCK-WORLD-46630") {
    throw new Error("broadcast requires --confirm DEPLOY-STOCK-WORLD-46630");
  }
  if (!isIgnored(args.secretPath)) throw new Error(`secret path is not ignored: ${args.secretPath}`);
  if (!isIgnored(args.outputPath)) throw new Error(`report path is not ignored: ${args.outputPath}`);

  const secrets = readJson(args.secretPath);
  const rawWallet = new ethers.Wallet(privateKeyFor(secrets, config.deployer));
  if (rawWallet.address.toLowerCase() !== config.deployer.toLowerCase()) {
    throw new Error(`private key resolves to ${rawWallet.address}, expected ${config.deployer}`);
  }
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(`wrong chain: expected ${config.chainId}, received ${network.chainId}`);
  }
  const signer = new ethers.NonceManager(rawWallet.connect(provider));

  const configText = fs.readFileSync(args.configPath, "utf8");
  const configHash = ethers.keccak256(ethers.toUtf8Bytes(configText));
  let report;
  if (fs.existsSync(args.outputPath)) {
    report = readJson(args.outputPath);
    if (report.schemaVersion !== REPORT_SCHEMA_VERSION || report.configHash !== configHash) {
      throw new Error("existing deployment report does not match this testnet manifest");
    }
  } else {
    report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: "deploying",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath: args.configPath,
      configHash,
      chainId: String(config.chainId),
      deployer: ethers.getAddress(config.deployer),
      contracts: {},
      transactions: [],
    };
  }

  function checkpoint() {
    report.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  async function codeExists(address) {
    return Boolean(address) && await provider.getCode(address) !== "0x";
  }

  async function deploy(key, name, constructorArgs = []) {
    const saved = report.contracts[key];
    if (saved?.address) {
      if (!(await codeExists(saved.address))) {
        if (!saved.transactionHash) throw new Error(`${key} checkpoint has no transaction hash`);
        const receipt = await provider.waitForTransaction(saved.transactionHash, 1, 120_000);
        if (!receipt || receipt.status !== 1 || !(await codeExists(saved.address))) {
          throw new Error(`${key} checkpoint did not produce contract code`);
        }
        saved.status = "mined";
        saved.blockNumber = receipt.blockNumber;
        saved.gasUsed = receipt.gasUsed.toString();
        checkpoint();
      }
      return new ethers.Contract(saved.address, artifact(name).abi, signer);
    }
    const item = artifact(name);
    const factory = new ethers.ContractFactory(item.abi, item.bytecode, signer);
    const contract = await factory.deploy(...constructorArgs);
    const tx = contract.deploymentTransaction();
    report.contracts[key] = {
      contractName: name,
      address: await contract.getAddress(),
      transactionHash: tx.hash,
      status: "pending",
    };
    checkpoint();
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`${key} deployment failed`);
    report.contracts[key] = {
      ...report.contracts[key],
      status: "mined",
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
    report.transactions.push({
      label: `deploy:${key}`,
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: "mined",
    });
    checkpoint();
    return contract;
  }

  async function transact(label, action) {
    const saved = report.transactions.find((entry) => entry.label === label && entry.status !== "failed");
    if (saved) {
      const receipt = await provider.waitForTransaction(saved.hash, 1, 120_000);
      if (!receipt || receipt.status !== 1) throw new Error(`${label} checkpoint did not confirm`);
      saved.status = "mined";
      saved.blockNumber = receipt.blockNumber;
      saved.gasUsed = receipt.gasUsed.toString();
      checkpoint();
      return saved;
    }
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
    return entry;
  }

  for (const name of [
    "MockV4PoolManager",
    "MockV4Permit2",
    "MockV4PositionManager",
    "MockQuoteAsset",
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
  ]) artifact(name);

  const deployerAddress = ethers.getAddress(config.deployer);
  const poolManager = await deploy("mockPoolManager", "MockV4PoolManager");
  const permit2 = await deploy("mockPermit2", "MockV4Permit2");
  const positionManager = await deploy("mockPositionManager", "MockV4PositionManager", [
    await poolManager.getAddress(),
    await permit2.getAddress(),
  ]);
  const hookDeployer = await deploy("hookDeployer", "StockWorldHookDeployer");
  const hookArtifact = artifact("StockWorldHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [await poolManager.getAddress(), deployerAddress],
  );
  const hookInitCode = ethers.concat([hookArtifact.bytecode, hookArgs]);
  const minedHook = mineHookSalt(await hookDeployer.getAddress(), hookInitCode);
  if (!(await codeExists(minedHook.predicted))) {
    await transact("create2:hook", () =>
      hookDeployer.deploy(minedHook.salt, hookInitCode, { gasLimit: 12_000_000 })
    );
  }
  report.contracts.hook = {
    contractName: "StockWorldHook",
    address: minedHook.predicted,
    salt: minedHook.salt,
    initCodeHash: minedHook.initCodeHash,
    status: "mined",
  };
  checkpoint();
  const hook = new ethers.Contract(minedHook.predicted, hookArtifact.abi, signer);

  const guard = await deploy("graduationGuard", "StockWorldGraduationGuard");
  const locker = await deploy("liquidityLocker", "StockWorldLiquidityLocker", [await positionManager.getAddress()]);
  const coordinator = await deploy("graduationCoordinator", "StockWorldGraduationCoordinator", [
    await poolManager.getAddress(),
    await positionManager.getAddress(),
    await permit2.getAddress(),
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

  const quote = config.mockQuoteAsset;
  const quoteAsset = await deploy("mockQuoteAsset", "MockQuoteAsset", [quote.name, quote.symbol, quote.decimals]);
  const quoteAddress = await quoteAsset.getAddress();
  const quoteInfo = await quoteRegistry.getQuoteAsset(quoteAddress);
  if (!quoteInfo.registered) {
    await transact("register:mockQuoteAsset", () => quoteRegistry.registerQuoteAsset(
      quoteAddress,
      ethers.parseUnits(quote.phantomQuote, quote.decimals),
      ethers.parseUnits(quote.graduationThreshold, quote.decimals),
    ));
  }

  if (config.launchSmokeWorld && !report.smokeWorld) {
    if (await factory.worldCount() === 0n) {
      const launchFee = ethers.parseEther("0.0003");
      const imageHash = ethers.id("stock-world-testnet-smoke-image");
      await transact("launch:smokeWorld", () => factory.launchWorld(
        [
          "Stock World Test",
          "SWT",
          ethers.ZeroAddress,
          deployerAddress,
          ethers.parseEther("4.2"),
          9999,
          4500,
          4500,
          1000,
          [3, [300, 300, 1200, 999, 1]],
          [
            imageHash,
            ethers.id("stock-world-testnet-smoke-vector"),
            ethers.id("stock-world-testnet-smoke-palette"),
            ethers.id("stock-world-testnet-smoke-style"),
            `seed://${imageHash.slice(2)}`,
            1,
          ],
        ],
        { value: launchFee, gasLimit: 50_000_000 },
      ));
    }
    const world = await factory.getWorld(0);
    const launchEntry = report.transactions.find((entry) => entry.label === "launch:smokeWorld");
    report.smokeWorld = {
      worldId: "0",
      worldToken: world.worldToken,
      worldNft: world.worldNft,
      bondingCurve: world.bondingCurve,
      fairMintController: world.fairMintController,
      transactionHash: launchEntry?.hash || null,
    };
    checkpoint();
  }

  if (!(await hook.hookPermissionsValid())) throw new Error("Hook permission bits are invalid");
  if ((await coordinator.factory()).toLowerCase() !== (await factory.getAddress()).toLowerCase()) {
    throw new Error("Coordinator Factory binding mismatch");
  }
  if ((await factory.worldCount()) < BigInt(config.launchSmokeWorld ? 1 : 0)) {
    throw new Error("smoke World was not registered");
  }

  const factoryReceipt = await provider.getTransactionReceipt(report.contracts.factory.transactionHash);
  report.factoryDeploymentBlock = Number(factoryReceipt.blockNumber);
  report.status = "deployed-and-smoke-tested";
  report.balanceAfterEth = ethers.formatEther(await provider.getBalance(deployerAddress));

  if (args.siteConfigPath) {
    const siteConfig = {
      chainId: Number(config.chainId),
      chainName: config.chainName,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      factoryAddress: ethers.getAddress(await factory.getAddress()),
      factoryDeploymentBlock: report.factoryDeploymentBlock,
      indexerChunkSize: 10000,
      activityScanBlocks: 50000,
      blockTimeSeconds: 0.1,
      confirmations: 1,
      environment: "testnet",
      quoteAssets: [{ address: ethers.getAddress(quoteAddress) }],
    };
    fs.writeFileSync(args.siteConfigPath, `${JSON.stringify(siteConfig, null, 2)}\n`);
    report.siteConfigPath = args.siteConfigPath;
  }
  checkpoint();

  console.log(JSON.stringify({
    status: report.status,
    chainId: report.chainId,
    factoryAddress: report.contracts.factory.address,
    factoryDeploymentBlock: report.factoryDeploymentBlock,
    mockQuoteAsset: report.contracts.mockQuoteAsset.address,
    smokeWorld: report.smokeWorld || null,
    explorer: `${config.explorerUrl}/address/${report.contracts.factory.address}`,
    balanceAfterEth: report.balanceAfterEth,
    reportPath: args.outputPath,
    siteConfigPath: report.siteConfigPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
