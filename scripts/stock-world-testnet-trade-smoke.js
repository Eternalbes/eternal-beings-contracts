const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const DEFAULT_CONFIG = "config/stock-world.testnet.json";
const DEFAULT_DEPLOYMENT = "reports/deployment-stock-world-fast-test-world.json";
const DEFAULT_SECRET = "reports/secrets/deployer.secrets.json";
const DEFAULT_OUTPUT = "reports/deployment-stock-world-testnet-trade-smoke.json";
const CONFIRMATION = "RUN-STOCK-WORLD-TRADE-SMOKE-46630";

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG,
    deploymentPath: DEFAULT_DEPLOYMENT,
    secretPath: DEFAULT_SECRET,
    outputPath: DEFAULT_OUTPUT,
    quoteIn: "0.000001",
    broadcast: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") args.configPath = argv[++index];
    else if (arg === "--deployment") args.deploymentPath = argv[++index];
    else if (arg === "--secret") args.secretPath = argv[++index];
    else if (arg === "--output") args.outputPath = argv[++index];
    else if (arg === "--quote-in") args.quoteIn = argv[++index];
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

function deadline(block) {
  return BigInt(block.timestamp + 1_200);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(args.configPath);
  const deployment = readJson(args.deploymentPath);
  if (Number(config.chainId) !== 46630) throw new Error("this smoke test only permits Robinhood Chain Testnet");
  if (!deployment.bondingCurve || !deployment.worldToken) throw new Error("test World deployment is incomplete");

  const quoteIn = ethers.parseEther(args.quoteIn);
  if (quoteIn <= 0n || quoteIn > ethers.parseEther("0.001")) {
    throw new Error("quote input must be above zero and at most 0.001 test ETH");
  }

  if (!args.broadcast) {
    console.log(JSON.stringify({
      status: "plan-only-ready",
      chainId: config.chainId,
      worldId: deployment.worldId,
      bondingCurve: deployment.bondingCurve,
      quoteIn: args.quoteIn,
      actions: ["buy", "approve-unlimited", "sell-25-percent"],
      next: `npm run stock-world:testnet-trade-smoke -- --broadcast --confirm ${CONFIRMATION}`,
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
  if (await provider.getCode(deployment.bondingCurve) === "0x") throw new Error("bonding curve has no deployed code");
  if (await provider.getCode(deployment.worldToken) === "0x") throw new Error("World Token has no deployed code");

  const secrets = readJson(args.secretPath);
  const rawWallet = new ethers.Wallet(privateKeyFor(secrets, config.deployer));
  if (rawWallet.address.toLowerCase() !== config.deployer.toLowerCase()) {
    throw new Error(`secret resolves to ${rawWallet.address}, expected ${config.deployer}`);
  }
  const signer = new ethers.NonceManager(rawWallet.connect(provider));
  const curve = new ethers.Contract(deployment.bondingCurve, artifact("StockWorldBondingCurve").abi, signer);
  const token = new ethers.Contract(deployment.worldToken, artifact("WorldToken").abi, signer);

  const [phase, ready, balanceBefore, tokenBefore, preview, latestBlock] = await Promise.all([
    curve.phase(),
    curve.readyToGraduate(),
    provider.getBalance(config.deployer),
    token.balanceOf(config.deployer),
    curve.previewBuy(quoteIn),
    provider.getBlock("latest"),
  ]);
  if (Number(phase) !== 1 || ready) throw new Error("test World curve is not safely open for a smoke trade");
  if (preview.tokensOut <= 0n || preview.fee <= 0n || preview.refund !== 0n) {
    throw new Error("buy preview is not a complete non-zero fill");
  }

  const buyGas = await curve.buy.estimateGas(
    quoteIn,
    preview.tokensOut * 9_900n / 10_000n,
    config.deployer,
    deadline(latestBlock),
    { value: quoteIn },
  );
  const feeData = await provider.getFeeData();
  const feePerGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  if (balanceBefore < quoteIn + buyGas * feePerGas * 2n) throw new Error("insufficient test ETH for smoke trade and gas");

  const buyTransaction = await curve.buy(
    quoteIn,
    preview.tokensOut * 9_900n / 10_000n,
    config.deployer,
    deadline(latestBlock),
    { value: quoteIn, gasLimit: buyGas * 120n / 100n },
  );
  const buyReceipt = await buyTransaction.wait(1);
  if (buyReceipt.status !== 1) throw new Error("testnet buy failed");
  const tokenAfterBuy = await token.balanceOf(config.deployer);
  const purchased = tokenAfterBuy - tokenBefore;
  if (purchased !== preview.tokensOut) throw new Error("testnet buy token delta does not match preview");

  const approvalTransaction = await token.approve(deployment.bondingCurve, ethers.MaxUint256);
  const approvalReceipt = await approvalTransaction.wait(1);
  if (approvalReceipt.status !== 1) throw new Error("unlimited approval failed");
  const allowanceAfterApproval = await token.allowance(config.deployer, deployment.bondingCurve);
  if (allowanceAfterApproval !== ethers.MaxUint256) throw new Error("unlimited approval was not stored");

  const sellAmount = purchased / 4n;
  if (sellAmount <= 0n) throw new Error("purchased amount is too small to sell");
  const [sellPreview, sellBlock] = await Promise.all([curve.previewSell(sellAmount), provider.getBlock("latest")]);
  if (sellPreview.quoteOut <= 0n || sellPreview.fee <= 0n) throw new Error("sell preview is zero");
  const sellTransaction = await curve.sell(
    sellAmount,
    sellPreview.quoteOut * 9_900n / 10_000n,
    config.deployer,
    deadline(sellBlock),
  );
  const sellReceipt = await sellTransaction.wait(1);
  if (sellReceipt.status !== 1) throw new Error("testnet sell failed");

  const [tokenAfterSell, allowanceAfterSell, finalPhase, finalReady] = await Promise.all([
    token.balanceOf(config.deployer),
    token.allowance(config.deployer, deployment.bondingCurve),
    curve.phase(),
    curve.readyToGraduate(),
  ]);
  if (tokenAfterBuy - tokenAfterSell !== sellAmount) throw new Error("testnet sell token delta is incorrect");
  if (allowanceAfterSell !== ethers.MaxUint256) throw new Error("unlimited approval was unexpectedly reduced");
  if (Number(finalPhase) !== 1 || finalReady) throw new Error("smoke trade unexpectedly changed graduation state");

  const report = {
    schemaVersion: 1,
    status: "passed",
    testedAt: new Date().toISOString(),
    chainId: String(config.chainId),
    worldId: String(deployment.worldId),
    wallet: ethers.getAddress(config.deployer),
    bondingCurve: ethers.getAddress(deployment.bondingCurve),
    worldToken: ethers.getAddress(deployment.worldToken),
    buy: {
      transactionHash: buyReceipt.hash,
      blockNumber: buyReceipt.blockNumber,
      quoteIn: ethers.formatEther(quoteIn),
      tokensOut: ethers.formatEther(purchased),
    },
    approval: {
      transactionHash: approvalReceipt.hash,
      blockNumber: approvalReceipt.blockNumber,
      unlimited: allowanceAfterSell === ethers.MaxUint256,
    },
    sell: {
      transactionHash: sellReceipt.hash,
      blockNumber: sellReceipt.blockNumber,
      tokensIn: ethers.formatEther(sellAmount),
      quoteOut: ethers.formatEther(sellPreview.quoteOut),
    },
    final: {
      tokenBalance: ethers.formatEther(tokenAfterSell),
      curvePhase: Number(finalPhase),
      readyToGraduate: finalReady,
    },
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.shortMessage || error.reason || error.message || error);
  process.exit(1);
});
