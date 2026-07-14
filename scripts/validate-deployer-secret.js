const fs = require("fs");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const [rpcUrl, secretPath, deployerAddress, minBalanceEth = "0"] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/validate-deployer-secret.js <rpcUrl> <secretPath> <deployerAddress> [minBalanceEth]",
      "",
      "Validates that an ignored secret file contains the deployer key. The private key is never printed.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function isIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "-q", path], { cwd: process.cwd() });
  return result.status === 0;
}

async function main() {
  if (!rpcUrl || !secretPath || !deployerAddress) {
    usage();
    process.exit(1);
  }
  if (!ethers.isAddress(deployerAddress) || deployerAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("deployerAddress must be a non-zero address");
  }
  const secrets = readJson(secretPath);
  const lower = deployerAddress.toLowerCase();
  const entry = (secrets.wallets || []).find((wallet) => String(wallet.address).toLowerCase() === lower);
  if (!entry || !entry.privateKey) throw new Error(`missing private key for ${deployerAddress}`);
  const wallet = new ethers.Wallet(entry.privateKey);
  if (wallet.address.toLowerCase() !== lower) {
    throw new Error(`private key resolves to ${wallet.address}, expected ${deployerAddress}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const [network, balance] = await Promise.all([provider.getNetwork(), provider.getBalance(deployerAddress)]);
  const minBalanceWei = ethers.parseEther(minBalanceEth);
  const report = {
    checkedAt: new Date().toISOString(),
    chainId: network.chainId.toString(),
    secretPath,
    secretPathIgnoredByGit: isIgnored(secretPath),
    deployerAddress,
    balanceWei: balance.toString(),
    balanceEth: ethers.formatEther(balance),
    minBalanceEth,
    hasEnoughBalance: balance >= minBalanceWei,
    ok: isIgnored(secretPath) && balance >= minBalanceWei,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
