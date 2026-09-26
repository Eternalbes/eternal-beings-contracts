const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const DEFAULT_CONFIG = "config/stock-world.testnet.json";
const DEFAULT_DEPLOYMENT = "reports/deployment-stock-world-testnet-three-step-v5.json";
const DEFAULT_SECRET = "reports/secrets/deployer.secrets.json";
const DEFAULT_OUTPUT = "reports/deployment-stock-world-fast-test-world.json";
const CONFIRMATION = "LAUNCH-FAST-TEST-WORLD-46630";

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG,
    deploymentPath: DEFAULT_DEPLOYMENT,
    secretPath: DEFAULT_SECRET,
    outputPath: DEFAULT_OUTPUT,
    broadcast: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") args.configPath = argv[++index];
    else if (arg === "--deployment") args.deploymentPath = argv[++index];
    else if (arg === "--secret") args.secretPath = argv[++index];
    else if (arg === "--output") args.outputPath = argv[++index];
    else if (arg === "--confirm") args.confirm = argv[++index];
    else if (arg === "--broadcast") args.broadcast = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(args.configPath);
  const deployment = readJson(args.deploymentPath);
  const factoryAddress = deployment.contracts?.factory?.address;
  if (!factoryAddress) throw new Error("deployment report does not contain a Factory address");
  if (Number(config.chainId) !== 46630) throw new Error("this script only permits Robinhood Chain Testnet");
  if (!args.broadcast) {
    console.log(JSON.stringify({
      status: "plan-only-ready",
      chainId: config.chainId,
      factoryAddress,
      schedule: { commitBlocks: 300, revealBlocks: 300, claimBlocks: 1200, epochCapacity: 100, walletLimit: 10 },
      next: `node scripts/stock-world-launch-fast-test-world.js --broadcast --confirm ${CONFIRMATION}`,
    }, null, 2));
    return;
  }
  if (args.confirm !== CONFIRMATION) throw new Error(`broadcast requires --confirm ${CONFIRMATION}`);
  if (!isIgnored(args.secretPath)) throw new Error(`secret path is not ignored: ${args.secretPath}`);
  if (!isIgnored(args.outputPath)) throw new Error(`report path is not ignored: ${args.outputPath}`);

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(`wrong chain: expected ${config.chainId}, received ${network.chainId}`);
  }
  if (await provider.getCode(factoryAddress) === "0x") throw new Error("Factory has no deployed code");

  const secrets = readJson(args.secretPath);
  const rawWallet = new ethers.Wallet(privateKeyFor(secrets, config.deployer));
  if (rawWallet.address.toLowerCase() !== config.deployer.toLowerCase()) {
    throw new Error(`secret resolves to ${rawWallet.address}, expected ${config.deployer}`);
  }
  const signer = new ethers.NonceManager(rawWallet.connect(provider));
  const artifact = readJson("artifacts/StockWorldFactory.json");
  const factory = new ethers.Contract(factoryAddress, artifact.abi, signer);

  const imageHash = ethers.id("eternal-beings-fast-test-world-image-v1");
  const worldConfig = [
    "Eternal Fast Test World",
    "EFAST",
    ethers.ZeroAddress,
    config.deployer,
    ethers.parseEther("4.2"),
    100,
    4000,
    4000,
    2000,
    [3, [300, 300, 1200, 100, 10]],
    [
      imageHash,
      ethers.id("eternal-beings-fast-test-world-vector-v1"),
      ethers.id("eternal-beings-fast-test-world-palette-v1"),
      ethers.id("eternal-beings-fast-test-world-style-v1"),
      `seed://${imageHash.slice(2)}`,
      1,
    ],
  ];
  const launchFee = ethers.parseEther("0.0003");
  const [balance, gasEstimate, feeData, worldCountBefore] = await Promise.all([
    provider.getBalance(config.deployer),
    factory.launchWorld.estimateGas(worldConfig, { value: launchFee }),
    provider.getFeeData(),
    factory.worldCount(),
  ]);
  const feePerGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasLimit = gasEstimate * 120n / 100n;
  const required = launchFee + gasLimit * feePerGas;
  if (balance < required) {
    throw new Error(`insufficient test ETH: have ${ethers.formatEther(balance)}, need about ${ethers.formatEther(required)}`);
  }

  const transaction = await factory.launchWorld(worldConfig, { value: launchFee, gasLimit });
  const pending = {
    schemaVersion: 1,
    status: "pending",
    createdAt: new Date().toISOString(),
    chainId: String(config.chainId),
    factoryAddress: ethers.getAddress(factoryAddress),
    deployer: ethers.getAddress(config.deployer),
    transactionHash: transaction.hash,
    expectedWorldId: worldCountBefore.toString(),
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });

  const receipt = await transaction.wait(1);
  let launched = null;
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "WorldLaunched") launched = parsed;
    } catch (_) {}
  }
  if (!launched) throw new Error("WorldLaunched event was not found in the receipt");
  const worldId = launched.args.worldId;
  const world = await factory.getWorld(worldId);
  const mintArtifact = readJson("artifacts/FairMintController.json");
  const mint = new ethers.Contract(world.fairMintController, mintArtifact.abi, provider);
  const [commitBlocks, revealBlocks, claimBlocks, epochCapacity, walletLimit, startBlock] = await Promise.all([
    mint.commitBlocks(), mint.revealBlocks(), mint.claimBlocks(), mint.epochCapacity(), mint.walletLimit(), mint.startBlock(),
  ]);
  const report = {
    ...pending,
    status: "deployed",
    confirmedAt: new Date().toISOString(),
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    worldId: worldId.toString(),
    worldToken: world.worldToken,
    tokenRewardVault: world.tokenRewardVault,
    worldRewardVault: world.worldRewardVault,
    bondingCurve: world.bondingCurve,
    worldNft: world.worldNft,
    fairMintController: world.fairMintController,
    graduationEscrow: world.graduationEscrow,
    schedule: {
      startBlock: startBlock.toString(),
      commitBlocks: commitBlocks.toString(),
      revealBlocks: revealBlocks.toString(),
      claimBlocks: claimBlocks.toString(),
      epochCapacity: epochCapacity.toString(),
      walletLimit: walletLimit.toString(),
    },
  };
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.shortMessage || error.reason || error.message || error);
  process.exit(1);
});
