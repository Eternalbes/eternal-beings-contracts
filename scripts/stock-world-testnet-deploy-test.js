const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { spawn } = require("child_process");
const ganache = require("ganache");
const { ethers } = require("ethers");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
  });
}

async function main() {
  const securitySmoke = process.argv.includes("--security-smoke");
  const wallet = ethers.Wallet.createRandom();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "stock-world-deploy-test-"));
  fs.mkdirSync("reports/secrets", { recursive: true });
  const secret = path.join("reports/secrets", `local-${path.basename(temporary)}.json`);
  const output = path.join("reports", `deployment-${path.basename(temporary)}.json`);
  const smokeOutput = `${output}.smoke.json`;
  const mintSecret = `${secret}.mint.json`;
  const configPath = path.join(temporary, "config.json");
  const sitePath = path.join(temporary, "site.json");
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 46630, hardfork: "shanghai" },
    miner: { blockGasLimit: 120_000_000, blockTime: securitySmoke ? 0.1 : 0 },
    wallet: { accounts: [{ secretKey: wallet.privateKey, balance: ethers.toBeHex(ethers.parseEther("10")) }] },
  });
  let provider;
  let listening = false;
  try {
    await server.listen(0, "127.0.0.1");
    listening = true;
    await require("./stock-world-block-history").installLocalBlockClock(server.provider);
    const rpcUrl = `http://127.0.0.1:${server.address().port}`;
    provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const config = JSON.parse(fs.readFileSync("config/stock-world.testnet.json", "utf8"));
    Object.assign(config, { rpcUrl, deployer: wallet.address, quoteAssetAuthority: wallet.address,
      platformFeeRecipient: wallet.address, launchSmokeWorld: securitySmoke });
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(secret, JSON.stringify({ wallets: [{ address: wallet.address, privateKey: wallet.privateKey }] }), { mode: 0o600 });
    const args = ["scripts/stock-world-testnet-deploy.js", "--config", configPath,
      "--secret", secret, "--output", output, "--site-config", sitePath,
      "--broadcast", "--confirm", "DEPLOY-STOCK-WORLD-46630"];
    await run(args);
    if (securitySmoke) {
      await run(["scripts/stock-world-testnet-security-smoke.js", "--config", configPath,
        "--deployment", output, "--secret", secret, "--output", smokeOutput,
        "--mint-secret", mintSecret, "--budget", "0.02", "--broadcast", "--confirm", "TEST-STOCK-WORLD-SECURITY-46630"]);
      const smoke = JSON.parse(fs.readFileSync(smokeOutput, "utf8"));
      assert.equal(smoke.status, "passed");
      assert.equal(smoke.transactions.length, 14);
      console.log(`Security lifecycle smoke passed locally: ${smoke.checks.length} checks, ${smoke.transactions.length} transactions.`);
    }
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    const nonce = await provider.getTransactionCount(wallet.address);
    fs.writeFileSync(output, JSON.stringify({ ...report, buildId: ethers.ZeroHash }));
    await assert.rejects(() => run(args), /deployment build mismatch/);
    assert.equal(await provider.getTransactionCount(wallet.address), nonce);
    report.contracts.factory.status = "pending";
    delete report.contracts.factory.blockNumber;
    delete report.contracts.factory.gasUsed;
    delete report.contracts.factory.runtimeCodeHash;
    report.transactions = report.transactions.filter((entry) => entry.label !== "deploy:factory");
    fs.writeFileSync(output, JSON.stringify(report));
    await run(args);
    const resumed = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(await provider.getTransactionCount(wallet.address), nonce);
    assert.equal(resumed.contracts.factory.status, "mined");
    assert.ok(resumed.contracts.factory.blockNumber > 0);
    assert.ok(resumed.contracts.factory.runtimeCodeHash);
    assert.equal(resumed.transactions.filter((entry) => entry.label === "deploy:factory").length, 1);
    const site = JSON.parse(fs.readFileSync(sitePath, "utf8"));
    assert.equal(site.factoryDeploymentBlock, resumed.contracts.factory.blockNumber);
    assert.equal(site.factoryAddress, resumed.contracts.factory.address);
    console.log("Stock World testnet deployer local regression passed: build mismatch blocked, mined receipt recovered, no duplicate transactions.");
  } finally {
    provider?.destroy();
    if (listening) await server.close();
    for (const file of [secret, output, smokeOutput, mintSecret]) fs.rmSync(file, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
