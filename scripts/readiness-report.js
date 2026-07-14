const fs = require("fs");
const solc = require("solc");

const EXPECTED_ROOT = "0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f";
const RUNTIME_LIMIT = 24_576;
const RUNTIME_WARNING = 23_500;
const INITCODE_LIMIT = 49_152;
const INITCODE_WARNING = 48_000;

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`Missing required file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function requireFile(path) {
  if (!fs.existsSync(path)) throw new Error(`Missing required file: ${path}`);
  return path;
}

function bytecodeStats(name) {
  const artifact = readJson(`artifacts/${name}.json`);
  return {
    creationBytes: (artifact.bytecode.length - 2) / 2,
    runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
  };
}

function assertBelow(value, limit, message) {
  if (value >= limit) throw new Error(`${message}: ${value} >= ${limit}`);
}

function main() {
  const deployment = readJson("reports/deployment-mainnet.json");
  const proofs = readJson("reports/top-collections.proofs.json");
  const verify = readJson("reports/verify/verify-summary.json");
  const packageJson = readJson("package.json");

  const beings = bytecodeStats("EternalBeings");
  const renderer = bytecodeStats("EternalRenderer");

  assertBelow(beings.runtimeBytes, RUNTIME_LIMIT, "EternalBeings runtime exceeds EIP-170");
  assertBelow(beings.runtimeBytes, RUNTIME_WARNING, "EternalBeings runtime exceeds project warning threshold");
  assertBelow(beings.creationBytes, INITCODE_LIMIT, "EternalBeings initcode exceeds EIP-3860");
  assertBelow(beings.creationBytes, INITCODE_WARNING, "EternalBeings initcode exceeds project warning threshold");
  assertBelow(renderer.runtimeBytes, RUNTIME_LIMIT, "EternalRenderer runtime exceeds EIP-170");
  assertBelow(renderer.runtimeBytes, RUNTIME_WARNING, "EternalRenderer runtime exceeds project warning threshold");

  if (deployment.constructorArgs.topCollectionsRoot.toLowerCase() !== EXPECTED_ROOT) {
    throw new Error("deployment report root mismatch");
  }
  if (proofs.root.toLowerCase() !== EXPECTED_ROOT) {
    throw new Error("proof file root mismatch");
  }
  if (verify.constructorArgs.topCollectionsRoot.toLowerCase() !== EXPECTED_ROOT) {
    throw new Error("verify package root mismatch");
  }
  if (proofs.count !== 100 || proofs.entries.length !== 100) {
    throw new Error("proof file must contain 100 collection entries");
  }

  const requiredScripts = [
    "test",
    "being-status",
    "check-params",
    "cryptopunk-status",
    "external-devour-status",
    "local-rehearsal",
    "mainnet-params-flow-test",
    "deploy",
    "deploy:preflight",
    "deploy:from-secret",
    "postdeploy-check",
    "prelaunch-audit",
    "prepare-verify",
    "deployment-report",
    "mint-commitment",
    "mint-status",
    "ore-status",
    "proof-for-collection",
    "sepolia-clean-rehearsal",
    "sepolia-mint-abuse-readonly-test",
    "sepolia-tier-proof-check",
    "token-metadata",
    "validate-deployer-secret",
  ];
  for (const script of requiredScripts) {
    if (!packageJson.scripts[script]) throw new Error(`Missing npm script: ${script}`);
  }

  const docs = [
    "README.md",
    "CONTRACT_INTERACTION.md",
    "TESTNET_REHEARSAL.md",
    "DEPLOYMENT_CHECKLIST.md",
    "AUDIT_NOTES.md",
  ].map(requireFile);

  const files = {
    proofs: requireFile("reports/top-collections.proofs.json"),
    deploymentReport: requireFile("reports/deployment-mainnet.json"),
    verifySummary: requireFile("reports/verify/verify-summary.json"),
    standardJsonInput: requireFile("reports/verify/standard-json-input.json"),
    constructorArgs: requireFile("reports/verify/constructor-args.txt"),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    status: "ready-for-testnet-rehearsal",
    compilerVersion: solc.version(),
    expectedRoot: EXPECTED_ROOT,
    bytecode: {
      EternalBeings: beings,
      EternalRenderer: renderer,
      limits: {
        eip170RuntimeBytes: RUNTIME_LIMIT,
        projectRuntimeWarningBytes: RUNTIME_WARNING,
        eip3860InitcodeBytes: INITCODE_LIMIT,
        projectInitcodeWarningBytes: INITCODE_WARNING,
      },
    },
    collectionProofs: {
      count: proofs.count,
      tiers: proofs.tiers,
      root: proofs.root,
    },
    deploymentGasEstimate: deployment.deploymentGasEstimate,
    verify: {
      compilerVersion: verify.compilerVersion,
      fullyQualifiedName: verify.fullyQualifiedName,
      constructorArgsFile: verify.files.constructorArgs,
      standardJsonInputFile: verify.files.standardJsonInput,
    },
    npmScripts: requiredScripts,
    docs,
    files,
    nextSteps: [
      "Run npm test",
      "Run npm run prelaunch-audit",
      "Run npm run mainnet-params-flow-test",
      "Run npm run local-rehearsal",
      "Run scripts/deploy-preflight.js before any testnet or mainnet deployment",
      "Deploy with scripts/deploy-from-secret.js so private keys are not passed on the command line",
      "Run scripts/sepolia-clean-rehearsal.js after the clean testnet deployment",
      "Run scripts/postdeploy-check.js against testnet",
      "Complete TESTNET_REHEARSAL.md smoke test",
    ],
  };

  fs.writeFileSync("reports/readiness-report.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log("readiness-report ok");
}

main();
