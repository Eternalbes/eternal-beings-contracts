const fs = require("fs");
const { ethers } = require("ethers");

const networkName = process.argv[2] || "testnet";
const configPath = "config/robinhood-chain.json";

if (!fs.existsSync(configPath)) throw new Error(`Missing ${configPath}`);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const expected = config[networkName];
if (!expected) throw new Error(`Unknown Robinhood Chain environment: ${networkName}`);

const rpcUrl = process.env.RH_RPC_URL || expected.rpcUrl;

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();

  if (network.chainId !== BigInt(expected.chainId)) {
    throw new Error(
      `Wrong chain: expected Robinhood Chain ${networkName} (${expected.chainId}), received ${network.chainId}`,
    );
  }

  const blockNumber = await provider.getBlockNumber();
  console.log(
    JSON.stringify(
      {
        network: `${config.networkFamily} ${networkName}`,
        chainId: network.chainId.toString(),
        nativeCurrency: config.nativeCurrency,
        rpcUrl,
        explorerUrl: expected.explorerUrl,
        latestBlock: blockNumber,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
