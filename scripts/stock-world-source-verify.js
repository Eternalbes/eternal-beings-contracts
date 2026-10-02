const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");
const { loadBuild, assertBuild } = require("./deployment-build");

const SHARED = ["StockWorldHookDeployer", "StockWorldHook", "StockWorldGraduationGuard", "StockWorldLiquidityLocker", "StockWorldGraduationCoordinator", "QuoteAssetRegistry", "StockWorldConfigValidator", "StockWorldCoreDeployer", "StockWorldRenderer", "StockWorldNftDeployer", "StockWorldLaunchDeployer", "StockWorldFactory"];
const MODULES = {
  worldToken: "WorldToken", tokenRewardVault: "TokenRewardVault", worldRewardVault: "WorldRewardVault",
  bondingCurve: "StockWorldBondingCurve", worldNft: "WorldNFT", fairMintController: "FairMintController",
  graduationEscrow: "StockWorldGraduationEscrow",
};
const SERVICE = "https://sourcify.dev/server/v2";
const REPORT = "config/stock-world.mainnet-v8.json";
const RESULT = "reports/stock-world-source-verification-v8.json";

function prepareBundle() {
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const sharedBuild = loadBuild(SHARED);
  assertBuild(report, sharedBuild.buildId);
  const { artifacts } = loadBuild([...SHARED, ...Object.values(MODULES)]);
  function tree(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = `${dir}/${entry.name}`;
      return entry.isDirectory() ? tree(file) : file.endsWith(".sol") ? [file] : [];
    }).sort();
  }
  return {
    chainId: 4663, factory: report.contracts.factory.address,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com", buildId: report.buildId,
    compilerVersion: solc.version().split(".Emscripten")[0],
    stdJsonInput: {
      language: "Solidity",
      sources: Object.fromEntries(tree("src").map((file) => [file, { content: fs.readFileSync(file, "utf8") }])),
      settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: "shanghai", viaIR: true,
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
    },
    modules: Object.fromEntries(Object.entries(MODULES).map(([key, name]) => [key, `${artifacts[name].sourceName}:${name}`])),
    shared: Object.values(report.contracts).map((contract) => ({
      address: contract.address, name: contract.contractName,
      contractIdentifier: `${artifacts[contract.contractName].sourceName}:${contract.contractName}`,
    })),
    factoryAbi: artifacts.StockWorldFactory.abi.filter((entry) => entry.type === "function" && ["getWorld", "worldCount"].includes(entry.name)),
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Verification service HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const bundle = prepareBundle();
  const bundlePath = process.argv[2];
  if (bundlePath) {
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    console.log(`Public compiler input written: ${bundlePath}`);
    return;
  }
  const provider = new ethers.JsonRpcProvider(bundle.rpcUrl);
  if (Number((await provider.getNetwork()).chainId) !== bundle.chainId) throw new Error("Wrong RPC chain");
  const factory = new ethers.Contract(bundle.factory, bundle.factoryAbi, provider);
  const count = Number(await factory.worldCount());
  if (!Number.isSafeInteger(count) || count > 10000) throw new Error("Unexpected world count");
  const targets = [...bundle.shared];
  for (let id = 0; id < count; id++) {
    const world = await factory.getWorld(id);
    for (const [field, contractIdentifier] of Object.entries(bundle.modules)) {
      targets.push({ address: world[field], name: `${id}:${field}`, contractIdentifier });
    }
  }
  let saved = { buildId: bundle.buildId, chainId: bundle.chainId, contracts: {} };
  if (fs.existsSync(RESULT)) saved = JSON.parse(fs.readFileSync(RESULT, "utf8"));
  if (saved.buildId !== bundle.buildId) throw new Error("Verification checkpoint build mismatch");
  function checkpoint() {
    saved.updatedAt = new Date().toISOString();
    fs.writeFileSync(RESULT, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  for (const target of targets) {
    const key = target.address.toLowerCase();
    const entry = saved.contracts[key] ||= { ...target };
    try {
      const match = await jsonRequest(`${SERVICE}/contract/${bundle.chainId}/${target.address}`);
      if (match?.creationMatch === "exact_match" && match?.runtimeMatch === "exact_match") {
        entry.status = "verified"; entry.match = match; delete entry.error;
      } else if (!entry.verificationId || entry.status === "failed") {
        const job = await jsonRequest(`${SERVICE}/verify/${bundle.chainId}/${target.address}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ stdJsonInput: bundle.stdJsonInput, compilerVersion: bundle.compilerVersion, contractIdentifier: target.contractIdentifier }),
        });
        if (!job?.verificationId) throw new Error("No verification job ID returned");
        entry.verificationId = job.verificationId; entry.status = "pending"; delete entry.error;
      }
      if (entry.status === "pending") {
        const job = await jsonRequest(`${SERVICE}/verify/${entry.verificationId}`);
        if (job?.isJobCompleted) {
          entry.status = job.contract?.creationMatch === "exact_match" && job.contract?.runtimeMatch === "exact_match" ? "verified" : "failed";
          entry.match = job.contract;
          entry.external = Object.fromEntries(Object.entries(job.externalVerifications || {}).map(([name, value]) => [name, {
            status: value.status, error: value.error?.message?.slice(0, 160),
          }]));
          if (job.error) entry.error = JSON.stringify(job.error).slice(0, 240);
        }
      }
    } catch (error) { entry.error = error.message; }
    checkpoint();
    console.log(`${entry.name} ${target.address} ${entry.status || "retry"}${entry.error ? ` (${entry.error})` : ""}`);
  }
  console.log(JSON.stringify({ total: targets.length, verified: targets.filter((target) => saved.contracts[target.address.toLowerCase()].status === "verified").length }));
  provider.destroy();
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareBundle, MODULES, SHARED };
