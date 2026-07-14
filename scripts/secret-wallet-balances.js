const fs = require("fs");
const { ethers } = require("ethers");

const [rpcUrl, secretPath, limitRaw = "0"] = process.argv.slice(2);

function usage() {
  console.error("Usage: node scripts/secret-wallet-balances.js <rpcUrl> <secretPath> [limit]");
}

async function main() {
  if (!rpcUrl || !secretPath) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(secretPath)) throw new Error(`missing file: ${secretPath}`);
  const limit = Number(limitRaw);
  const secrets = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  const wallets = limit > 0 ? (secrets.wallets || []).slice(0, limit) : (secrets.wallets || []);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const rows = [];
  for (const wallet of wallets) {
    const balance = await provider.getBalance(wallet.address);
    rows.push({
      index: wallet.index,
      address: wallet.address,
      balanceWei: balance.toString(),
      balanceEth: ethers.formatEther(balance),
      hasPrivateKey: Boolean(wallet.privateKey),
    });
  }
  console.log(JSON.stringify({ secretPath, wallets: rows }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
