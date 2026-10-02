const fs = require("node:fs");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error("Pass the completed deployment report path");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const config = JSON.parse(fs.readFileSync(report.configPath, "utf8"));
  assert.equal(report.status, "deployed");
  assert.equal(config.chainId, 4663);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  try {
    assert.equal((await provider.getNetwork()).chainId, 4663n);
    let spent = 0n;
    const hashes = [...new Set(report.gasGuardTransactions.map((entry) => entry.hash))];
    assert.equal(hashes.length, report.transactions.length);
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      const tx = await provider.getTransaction(hash);
      assert.equal(receipt?.status, 1, hash);
      assert.equal(tx.chainId, 4663n);
      assert.equal(tx.from.toLowerCase(), report.deployer.toLowerCase());
      assert.equal(tx.value, 0n);
      const ledger = report.gasGuardTransactions.find((entry) => entry.hash === hash);
      assert.equal(ethers.keccak256(tx.data), ledger.dataHash);
      assert.equal(tx.to?.toLowerCase() || null, ledger.to?.toLowerCase() || null);
      const cost = receipt.gasUsed * receipt.gasPrice;
      spent += cost;
      for (const entry of [...report.gasGuardTransactions, ...report.transactions]) {
        if ((entry.hash || entry.transactionHash) !== hash) continue;
        Object.assign(entry, { status: "mined", blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(), gasCostWei: cost.toString() });
      }
    }
    assert(spent <= BigInt(report.gasBudgetWei), "Gas budget exceeded");
    for (const saved of Object.values(report.contracts)) {
      const code = await provider.getCode(saved.address);
      assert.notEqual(code, "0x");
      assert.equal(ethers.keccak256(code), saved.runtimeCodeHash);
    }
    const contract = (key) => {
      const saved = report.contracts[key];
      const artifact = JSON.parse(fs.readFileSync(`artifacts/${saved.contractName}.json`, "utf8"));
      return new ethers.Contract(saved.address, artifact.abi, provider);
    };
    const factory = contract("factory");
    assert.equal(await factory.worldCount(), 0n, "This deployment must not create Worlds");
    assert.equal((await factory.graduationCoordinator()).toLowerCase(), report.contracts.graduationCoordinator.address.toLowerCase());
    assert.equal((await contract("graduationCoordinator").factory()).toLowerCase(), report.contracts.factory.address.toLowerCase());
    const registry = contract("quoteAssetRegistry");
    const assets = [];
    for (const spec of [{ address: ethers.ZeroAddress, phantomQuote: "1.68", graduationThreshold: "4.2" }, ...config.quoteAssets]) {
      assert.equal(await registry.isSupported(spec.address), true);
      const decimals = Number(await registry.decimalsOf(spec.address));
      const economics = await registry.economicsOf(spec.address);
      assert.equal(economics.phantomQuote, ethers.parseUnits(spec.phantomQuote, decimals));
      assert.equal(economics.graduationThreshold, ethers.parseUnits(spec.graduationThreshold, decimals));
      assets.push({ address: spec.address, decimals, graduationThreshold: spec.graduationThreshold });
    }
    report.gasSpentWei = spent.toString();
    report.postcheck = { checkedAt: new Date().toISOString(), signingEnabled: false,
      transactionCount: hashes.length, contractCount: Object.keys(report.contracts).length,
      worldCount: 0, gasSpentEth: ethers.formatEther(spent),
      walletBalanceEth: ethers.formatEther(await provider.getBalance(report.deployer)), assets };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ factory: report.contracts.factory.address,
      factoryDeploymentBlock: report.factoryDeploymentBlock, ...report.postcheck }, null, 2));
  } finally { provider.destroy(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
