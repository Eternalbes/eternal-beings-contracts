const fs = require("fs");
const { spawn } = require("child_process");
const ganache = require("ganache");
const { ethers } = require("ethers");

const rpcPort = 18546;
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const configPath = "/tmp/stock-world.production-fork-test.json";
const secretPath = "reports/secrets/stock-world-production-fork-test.secrets.json";
const outputPath = "reports/deployment-stock-world-fork-test.json";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${stderr}\n${stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const wallet = ethers.Wallet.createRandom();
  let server;

  try {
    server = ganache.server({
      logging: { quiet: true },
      chain: { chainId: 4663, networkId: 4663, hardfork: "shanghai" },
      fork: { url: "https://rpc.mainnet.chain.robinhood.com" },
      miner: { blockGasLimit: 120_000_000 },
      wallet: {
        accounts: [{
          secretKey: wallet.privateKey,
          balance: ethers.toBeHex(ethers.parseEther("10")),
        }],
      },
    });
    fs.mkdirSync("reports/secrets", { recursive: true });
    fs.writeFileSync(secretPath, `${JSON.stringify({
      wallets: [{ address: wallet.address, privateKey: wallet.privateKey }],
    }, null, 2)}\n`, { mode: 0o600 });

    const production = JSON.parse(fs.readFileSync("config/stock-world.production.json", "utf8"));
    production.status = "approved-for-deployment";
    production.rpcUrl = rpcUrl;
    production.deployer = wallet.address;
    production.quoteAssetAuthority = wallet.address;
    production.platformFeeRecipient = wallet.address;
    production.v4.productionApproved = true;
    production.quoteAssets = production.quoteAssets.slice(0, 1);
    fs.writeFileSync(configPath, `${JSON.stringify(production, null, 2)}\n`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    await server.listen(rpcPort, "127.0.0.1");
    const args = [
      "scripts/stock-world-production-deploy.js",
      "--config", configPath,
      "--secret", secretPath,
      "--output", outputPath,
      "--broadcast",
      "--confirm", "DEPLOY-STOCK-WORLD-4663",
    ];
    await run(process.execPath, args);
    await run(process.execPath, args);

    const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (report.status !== "deployed") throw new Error(`unexpected status: ${report.status}`);
    if (!report.contracts.factory?.address) throw new Error("factory address missing");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    if (await provider.getCode(report.contracts.factory.address) === "0x") {
      throw new Error("factory has no code after fork deployment");
    }
    console.log(JSON.stringify({
      status: "stock-world-production-deployer-fork-test-passed",
      factory: report.contracts.factory.address,
      transactionCount: report.transactions.length,
      resumeRunPassed: true,
    }, null, 2));
  } finally {
    if (server) await server.close();
    for (const path of [secretPath, outputPath, configPath]) {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
