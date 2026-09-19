const fs = require("fs");
const { ethers } = require("ethers");

const networkName = process.argv[2] || "mainnet";
const networkConfigPath = "config/robinhood-chain.json";
const observationPath = "config/robinhood-chain.v4-observed.json";

function loadJson(path) {
  if (!fs.existsSync(path)) throw new Error(`Missing ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function normalizeAddress(value, label) {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`Invalid ${label} address`);
  }
  return ethers.getAddress(value.toLowerCase());
}

function byteLength(code) {
  return (code.length - 2) / 2;
}

async function readAddress(provider, contract, signature, blockTag) {
  const data = ethers.id(signature).slice(0, 10);
  const result = await provider.call({ to: contract, data }, blockTag);
  if (result.length !== 66) throw new Error(`${signature} returned malformed data`);
  return ethers.getAddress(ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0]);
}

async function readUint256(provider, contract, signature, blockTag) {
  const data = ethers.id(signature).slice(0, 10);
  const result = await provider.call({ to: contract, data }, blockTag);
  if (result.length !== 66) throw new Error(`${signature} returned malformed data`);
  return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], result)[0];
}

async function attestCode(provider, label, record, blockTag) {
  const address = normalizeAddress(record.address, label);
  const code = await provider.getCode(address, blockTag);
  if (code === "0x") throw new Error(`${label} has no code at ${address}`);

  const actual = {
    address,
    codeBytes: byteLength(code),
    codeHash: ethers.keccak256(code),
  };
  if (actual.codeBytes !== record.codeBytes) {
    throw new Error(`${label} code size mismatch: expected ${record.codeBytes}, received ${actual.codeBytes}`);
  }
  if (actual.codeHash.toLowerCase() !== record.codeHash.toLowerCase()) {
    throw new Error(`${label} code hash mismatch: expected ${record.codeHash}, received ${actual.codeHash}`);
  }
  return actual;
}

async function fetchSourceVerification(chainId, address, fetchImpl = fetch) {
  const url =
    `https://sourcify.dev/server/v2/contract/${chainId}/${address}`
    + "?fields=compilation";
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Sourcify lookup failed for ${address}: HTTP ${response.status}`);
  return response.json();
}

function attestSource(label, record, source) {
  const expected = record.sourceVerification;
  const compilation = source.compilation;
  if (!expected || expected.provider !== "sourcify-v2") {
    throw new Error(`${label} has no pinned Sourcify v2 source record`);
  }
  if (!compilation) throw new Error(`${label} has no Sourcify compilation metadata`);

  const actual = {
    provider: "sourcify-v2",
    matchId: String(source.matchId),
    runtimeMatch: source.runtimeMatch,
    contractName: compilation.name,
    fullyQualifiedName: compilation.fullyQualifiedName,
    compilerVersion: compilation.compilerVersion,
    verifiedAt: source.verifiedAt,
  };
  for (const field of ["matchId", "runtimeMatch", "contractName", "fullyQualifiedName", "compilerVersion"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} source ${field} mismatch: expected ${expected[field]}, received ${actual[field]}`);
    }
  }
  return actual;
}

async function main() {
  const config = loadJson(networkConfigPath);
  const expectedNetwork = config[networkName];
  if (!expectedNetwork) throw new Error(`Unknown Robinhood Chain environment: ${networkName}`);

  const observation = loadJson(observationPath);
  if (BigInt(observation.chainId) !== BigInt(expectedNetwork.chainId)) {
    throw new Error(
      `No matching v4 observation for ${networkName}; observation chain ${observation.chainId}, expected ${expectedNetwork.chainId}`,
    );
  }

  const rpcUrl = process.env.RH_RPC_URL || expectedNetwork.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(expectedNetwork.chainId)) {
    throw new Error(`Wrong chain: expected ${expectedNetwork.chainId}, received ${network.chainId}`);
  }

  const latestBlock = await provider.getBlockNumber();
  if (latestBlock < observation.observedAtBlock) {
    throw new Error(`RPC is behind observation block ${observation.observedAtBlock}: received ${latestBlock}`);
  }

  const contracts = observation.contracts;
  const [poolManager, positionManager, permit2] = await Promise.all([
    attestCode(provider, "PoolManager", contracts.poolManager, latestBlock),
    attestCode(provider, "PositionManager", contracts.positionManager, latestBlock),
    attestCode(provider, "Permit2", contracts.permit2, latestBlock),
  ]);

  const [poolManagerSource, positionManagerSource, permit2Source] = await Promise.all([
    fetchSourceVerification(network.chainId, poolManager.address),
    fetchSourceVerification(network.chainId, positionManager.address),
    fetchSourceVerification(network.chainId, permit2.address),
  ]);
  const sources = {
    poolManager: attestSource("PoolManager", contracts.poolManager, poolManagerSource),
    positionManager: attestSource("PositionManager", contracts.positionManager, positionManagerSource),
    permit2: attestSource("Permit2", contracts.permit2, permit2Source),
  };

  const [reportedPoolManager, reportedPermit2, nextTokenId] = await Promise.all([
    readAddress(provider, positionManager.address, "poolManager()", latestBlock),
    readAddress(provider, positionManager.address, "permit2()", latestBlock),
    readUint256(provider, positionManager.address, "nextTokenId()", latestBlock),
  ]);
  if (reportedPoolManager !== poolManager.address) {
    throw new Error(`PositionManager.poolManager mismatch: ${reportedPoolManager}`);
  }
  if (reportedPermit2 !== permit2.address) {
    throw new Error(`PositionManager.permit2 mismatch: ${reportedPermit2}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "observed-v4-bytecode-wiring-and-source-match",
        productionApproved: false,
        network: `${config.networkFamily} ${networkName}`,
        chainId: network.chainId.toString(),
        checkedAtBlock: latestBlock,
        observationBlock: observation.observedAtBlock,
        contracts: { poolManager, positionManager, permit2 },
        sources,
        wiring: {
          positionManagerPoolManager: reportedPoolManager,
          positionManagerPermit2: reportedPermit2,
          positionManagerNextTokenId: nextTokenId.toString(),
        },
        warning:
          "This proves current bytecode, internal wiring, and pinned Sourcify source records match. It does not establish an official Uniswap deployment or approve production use.",
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  attestCode,
  attestSource,
  byteLength,
  fetchSourceVerification,
  normalizeAddress,
  readAddress,
  readUint256,
};
