const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  deployerAddress,
  topCollectionsRoot,
  royaltyReceiver,
  outputPath = "reports/deploy-preflight.json",
  rendererForEstimateRaw = "",
  profileArg = "",
] = process.argv.slice(2);

const EXPECTED_ROOT = "0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f";
const RUNTIME_LIMIT = 24_576;
const INITCODE_LIMIT = 49_152;

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/deploy-preflight.js <rpcUrl> <deployerAddress> <topCollectionsRoot> <royaltyReceiver> [outputPath] [rendererForEstimate] [profile]",
      "",
      "This does not need a private key and does not send transactions.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function byteLength(hex) {
  return (hex.replace(/^0x/, "").length / 2) | 0;
}

function assertAddress(address, label) {
  if (!ethers.isAddress(address) || address.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error(`${label} must be a non-zero address`);
  }
}

function assertParamProfile(profileName) {
  if (!profileName) return null;
  const profilePath = profileName.endsWith(".json") ? profileName : `config/contract-params.${profileName}.json`;
  if (!fs.existsSync(profilePath)) throw new Error(`missing parameter profile: ${profilePath}`);
  const profile = readJson(profilePath);
  const source = fs.readFileSync("src/EternalBeings.sol", "utf8");
  const entries = [
    ["uint256", "EPOCH_BLOCKS"],
    ["uint256", "COMMIT_BLOCKS"],
    ["uint256", "MINTS_PER_EPOCH"],
    ["uint256", "MAX_ENDURANCE"],
    ["uint256", "COOLDOWN_BLOCKS"],
    ["uint256", "UNKNOWN_HOLD_BLOCKS"],
    ["uint256", "CRYPTOPUNK_OBSERVATION_BLOCKS"],
    ["uint256", "UNKNOWN_MIN_TOTAL_SUPPLY"],
    ["uint32", "UNKNOWN_COLLECTION_DEVOUR_LIMIT"],
    ["uint96", "ROYALTY_BPS"],
  ];
  const mismatches = [];
  for (const [type, name] of entries) {
    if ((profile.constants || {})[name] === undefined) continue;
    const match = source.match(new RegExp(`${type}\\s+public\\s+constant\\s+${name}\\s*=\\s*([^;]+);`));
    if (!match) throw new Error(`missing source constant ${name}`);
    const actual = match[1].replace(/_/g, "").trim();
    const expected = String(profile.constants[name]).replace(/_/g, "").trim();
    if (actual !== expected) mismatches.push({ name, expected, actual: match[1].trim() });
  }
  if (mismatches.length > 0) throw new Error(`parameter profile mismatch: ${JSON.stringify(mismatches)}`);
  return { profile: profile.profile || profileName, profilePath };
}

async function rendererForEstimate(provider) {
  if (rendererForEstimateRaw) {
    assertAddress(rendererForEstimateRaw, "rendererForEstimate");
    if ((await provider.getCode(rendererForEstimateRaw)) === "0x") {
      throw new Error(`rendererForEstimate has no code: ${rendererForEstimateRaw}`);
    }
    return { address: rendererForEstimateRaw, source: "argument" };
  }
  const knownPath = "reports/sepolia-fast-deployment-v5.json";
  if (fs.existsSync(knownPath)) {
    const known = readJson(knownPath);
    if (known.rendererAddress && ethers.isAddress(known.rendererAddress)) {
      const code = await provider.getCode(known.rendererAddress);
      if (code !== "0x") return { address: known.rendererAddress, source: knownPath };
    }
  }
  return { address: null, source: null };
}

async function main() {
  if (!rpcUrl || !deployerAddress || !topCollectionsRoot || !royaltyReceiver) {
    usage();
    process.exit(1);
  }
  assertAddress(deployerAddress, "deployerAddress");
  assertAddress(royaltyReceiver, "royaltyReceiver");
  if (!ethers.isHexString(topCollectionsRoot, 32)) throw new Error("topCollectionsRoot must be bytes32");
  const paramProfile = assertParamProfile(profileArg);

  const proofs = readJson("reports/top-collections.proofs.json");
  if (proofs.root.toLowerCase() !== topCollectionsRoot.toLowerCase()) throw new Error("proof root mismatch");
  if (topCollectionsRoot.toLowerCase() !== EXPECTED_ROOT) throw new Error("unexpected topCollectionsRoot");
  if (proofs.count !== 100 || !Array.isArray(proofs.entries) || proofs.entries.length !== 100) {
    throw new Error("proof file must contain 100 entries");
  }

  const gameArtifact = readJson("artifacts/EternalBeings.json");
  const rendererArtifact = readJson("artifacts/EternalRenderer.json");
  const gameCreationBytes = byteLength(gameArtifact.bytecode);
  const gameRuntimeBytes = byteLength(gameArtifact.deployedBytecode);
  const rendererCreationBytes = byteLength(rendererArtifact.bytecode);
  const rendererRuntimeBytes = byteLength(rendererArtifact.deployedBytecode);
  if (gameRuntimeBytes >= RUNTIME_LIMIT) throw new Error("EternalBeings runtime exceeds EIP-170");
  if (gameCreationBytes >= INITCODE_LIMIT) throw new Error("EternalBeings initcode exceeds EIP-3860");
  if (rendererRuntimeBytes >= RUNTIME_LIMIT) throw new Error("EternalRenderer runtime exceeds EIP-170");
  if (rendererCreationBytes >= INITCODE_LIMIT) throw new Error("EternalRenderer initcode exceeds EIP-3860");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const [network, balance, nonce, feeData] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(deployerAddress),
    provider.getTransactionCount(deployerAddress),
    provider.getFeeData(),
  ]);

  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode);
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode);
  const predictedRendererAddress = ethers.getCreateAddress({ from: deployerAddress, nonce });
  const estimateRenderer = await rendererForEstimate(provider);
  const rendererTx = await rendererFactory.getDeployTransaction();
  const gameRendererAddress = estimateRenderer.address || predictedRendererAddress;
  const gameTx = await gameFactory.getDeployTransaction(topCollectionsRoot, royaltyReceiver, gameRendererAddress);
  const rendererGas = await provider.estimateGas({ from: deployerAddress, data: rendererTx.data });
  let gameGas;
  let gameGasSource = estimateRenderer.address ? "provider-estimate-with-existing-renderer" : "provider-estimate";
  try {
    gameGas = await provider.estimateGas({ from: deployerAddress, data: gameTx.data });
  } catch (error) {
    const deployment = readJson("reports/deployment-mainnet.json");
    gameGas = BigInt(deployment.deploymentGasEstimate.gameGasUsed);
    gameGasSource = `fallback:${error.shortMessage || error.reason || error.message}`;
  }
  const totalGas = rendererGas + gameGas;
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
  const estimatedCost = totalGas * gasPrice;
  const maxFeeCost = feeData.maxFeePerGas ? totalGas * feeData.maxFeePerGas : estimatedCost;

  const report = {
    createdAt: new Date().toISOString(),
    chainId: network.chainId.toString(),
    deployerAddress,
    deployerBalanceWei: balance.toString(),
    deployerBalanceEth: ethers.formatEther(balance),
    nonce,
    topCollectionsRoot,
    royaltyReceiver,
    paramProfile,
    predictedRendererAddress,
    estimateRendererAddress: estimateRenderer.address,
    estimateRendererSource: estimateRenderer.source,
    bytecode: {
      EternalBeings: { creationBytes: gameCreationBytes, runtimeBytes: gameRuntimeBytes },
      EternalRenderer: { creationBytes: rendererCreationBytes, runtimeBytes: rendererRuntimeBytes },
    },
    gas: {
      rendererGas: rendererGas.toString(),
      gameGas: gameGas.toString(),
      gameGasSource,
      totalGas: totalGas.toString(),
      gasPriceWei: gasPrice.toString(),
      maxFeePerGasWei: feeData.maxFeePerGas ? feeData.maxFeePerGas.toString() : null,
      maxPriorityFeePerGasWei: feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.toString() : null,
      estimatedCostWei: estimatedCost.toString(),
      estimatedCostEth: ethers.formatEther(estimatedCost),
      maxFeeCostWei: maxFeeCost.toString(),
      maxFeeCostEth: ethers.formatEther(maxFeeCost),
      balanceCoversGasPriceCost: balance >= estimatedCost,
      balanceCoversMaxFeeCost: balance >= maxFeeCost,
    },
    ok: balance >= estimatedCost && balance >= maxFeeCost,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
