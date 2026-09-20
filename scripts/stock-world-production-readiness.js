const fs = require("fs");
const { ethers } = require("ethers");
const {
  attestCode,
  attestSource,
  fetchSourceVerification,
  readAddress,
} = require("./stock-world-v4-attest");

const configPath = process.argv[2] || "config/stock-world.production.json";
const observationPath = "config/robinhood-chain.v4-observed.json";

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function validAddress(value) {
  return typeof value === "string" && ethers.isAddress(value) && value !== ethers.ZeroAddress;
}

function normalized(value) {
  return ethers.getAddress(value.toLowerCase());
}

function hours(blocks, secondsPerBlock) {
  return Number(((Number(blocks) * secondsPerBlock) / 3600).toFixed(2));
}

async function inspectQuoteAsset(provider, asset) {
  const address = normalized(asset);
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error(`${address} has no contract code`);
  const contract = new ethers.Contract(
    address,
    ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    provider,
  );
  const [name, symbol, decimals] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.decimals(),
  ]);
  if (Number(decimals) > 36) throw new Error(`${address} reports unsupported decimals`);
  return { address, name, symbol, decimals: Number(decimals) };
}

async function main() {
  const config = readJson(configPath);
  const observation = readJson(observationPath);
  const blockers = [];
  const warnings = [];
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  const latestBlock = await provider.getBlockNumber();

  if (network.chainId !== BigInt(config.chainId)) {
    blockers.push(`wrong chain: expected ${config.chainId}, received ${network.chainId}`);
  }
  if (BigInt(observation.chainId) !== network.chainId) {
    blockers.push(`V4 observation targets chain ${observation.chainId}, not ${network.chainId}`);
  }

  const sampleBlocks = Math.min(1000, latestBlock);
  const [latest, earlier] = await Promise.all([
    provider.getBlock(latestBlock),
    provider.getBlock(latestBlock - sampleBlocks),
  ]);
  const sampledSeconds = Math.max(1, latest.timestamp - earlier.timestamp);
  const secondsPerBlock = sampledSeconds / sampleBlocks;

  for (const field of ["deployer", "quoteAssetAuthority", "platformFeeRecipient"]) {
    if (!validAddress(config[field])) blockers.push(`${field} must be a non-zero address`);
  }

  const schedule = config.mintSchedule || {};
  for (const field of ["commitBlocks", "revealBlocks", "claimBlocks"]) {
    if (!Number.isSafeInteger(schedule[field]) || schedule[field] <= 0 || schedule[field] > 0xffffffff) {
      blockers.push(`mintSchedule.${field} must be a positive uint32 value`);
    }
  }
  const scheduleHours = {
    commit: hours(schedule.commitBlocks || 0, secondsPerBlock),
    reveal: hours(schedule.revealBlocks || 0, secondsPerBlock),
    claim: hours(schedule.claimBlocks || 0, secondsPerBlock),
  };
  if (scheduleHours.commit < 1) blockers.push("commit window is shorter than one sampled hour");
  if (scheduleHours.reveal < 1) blockers.push("reveal window is shorter than one sampled hour");
  if (scheduleHours.claim < 4) blockers.push("claim window is shorter than four sampled hours");
  warnings.push(
    `A 256-block blockhash capture window is currently about ${(256 * secondsPerBlock).toFixed(1)} seconds; permissionless finalization must be monitored.`,
  );

  const market = config.permanentMarket || {};
  if (market.poolFee !== 0) blockers.push("permanentMarket.poolFee must remain zero");
  if (!Number.isInteger(market.tickSpacing) || market.tickSpacing < 1 || market.tickSpacing > 32767) {
    blockers.push("permanentMarket.tickSpacing must be between 1 and 32767");
  }

  if (!config.v4?.productionApproved) {
    blockers.push("V4 production decision is still pending");
  }

  const observed = observation.contracts;
  for (const [field, observedField] of [
    ["poolManager", "poolManager"],
    ["positionManager", "positionManager"],
    ["permit2", "permit2"],
  ]) {
    const configured = config.v4?.[field];
    if (!validAddress(configured)) {
      blockers.push(`v4.${field} must be a non-zero address`);
    } else if (normalized(configured) !== normalized(observed[observedField].address)) {
      blockers.push(`v4.${field} differs from the pinned observation`);
    }
  }

  let v4Attestation = null;
  try {
    const [poolManager, positionManager, permit2] = await Promise.all([
      attestCode(provider, "PoolManager", observed.poolManager, latestBlock),
      attestCode(provider, "PositionManager", observed.positionManager, latestBlock),
      attestCode(provider, "Permit2", observed.permit2, latestBlock),
    ]);
    const [poolSource, positionSource, permitSource] = await Promise.all([
      fetchSourceVerification(network.chainId, poolManager.address),
      fetchSourceVerification(network.chainId, positionManager.address),
      fetchSourceVerification(network.chainId, permit2.address),
    ]);
    const [reportedPoolManager, reportedPermit2] = await Promise.all([
      readAddress(provider, positionManager.address, "poolManager()", latestBlock),
      readAddress(provider, positionManager.address, "permit2()", latestBlock),
    ]);
    if (reportedPoolManager !== poolManager.address) blockers.push("PositionManager.poolManager wiring mismatch");
    if (reportedPermit2 !== permit2.address) blockers.push("PositionManager.permit2 wiring mismatch");
    v4Attestation = {
      contracts: { poolManager, positionManager, permit2 },
      sources: {
        poolManager: attestSource("PoolManager", observed.poolManager, poolSource),
        positionManager: attestSource("PositionManager", observed.positionManager, positionSource),
        permit2: attestSource("Permit2", observed.permit2, permitSource),
      },
    };
  } catch (error) {
    blockers.push(`V4 attestation failed: ${error.message}`);
  }

  const quoteAssets = [];
  if (!Array.isArray(config.quoteAssets) || config.quoteAssets.length === 0) {
    blockers.push("at least one production quote asset must be selected and verified");
  } else {
    for (const asset of config.quoteAssets) {
      try {
        quoteAssets.push(await inspectQuoteAsset(provider, asset));
      } catch (error) {
        blockers.push(`quote asset ${asset}: ${error.message}`);
      }
    }
  }

  let deployerBalance = null;
  let deploymentCost = null;
  if (validAddress(config.deployer)) {
    const [balance, feeData] = await Promise.all([
      provider.getBalance(config.deployer),
      provider.getFeeData(),
    ]);
    deployerBalance = balance;
    const budget = config.deploymentGasBudget || {};
    const sharedGas = BigInt(budget.sharedContracts || 0);
    const registrationGas = BigInt(budget.perQuoteAssetRegistration || 0)
      * BigInt(Array.isArray(config.quoteAssets) ? config.quoteAssets.length : 0);
    const safetyBps = BigInt(budget.safetyBps || 10000);
    const feePerGas = feeData.maxFeePerGas || feeData.gasPrice;
    if (sharedGas === 0n || safetyBps < 10000n || !feePerGas) {
      blockers.push("deploymentGasBudget and live fee data must provide a non-zero, safety-adjusted estimate");
    } else {
      const estimatedGas = sharedGas + registrationGas;
      const requiredWei = estimatedGas * feePerGas * safetyBps / 10000n;
      deploymentCost = {
        estimatedGas: estimatedGas.toString(),
        feePerGasGwei: ethers.formatUnits(feePerGas, "gwei"),
        safetyBps: safetyBps.toString(),
        requiredWei: requiredWei.toString(),
        requiredEth: ethers.formatEther(requiredWei),
      };
      if (deployerBalance < requiredWei) {
        blockers.push(
          `deployer balance ${ethers.formatEther(deployerBalance)} ETH is below the dynamic ${ethers.formatEther(requiredWei)} ETH deployment estimate`,
        );
      }
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    configPath,
    status: blockers.length === 0 ? "ready-for-explicit-deployment-approval" : "blocked",
    chainId: network.chainId.toString(),
    latestBlock,
    sampledBlockCadence: { sampleBlocks, sampledSeconds, secondsPerBlock },
    mintScheduleHours: scheduleHours,
    deployerBalanceEth: deployerBalance === null ? null : ethers.formatEther(deployerBalance),
    deploymentCost,
    quoteAssets,
    v4Attestation,
    warnings,
    blockers,
  };
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
