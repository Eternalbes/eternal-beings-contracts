const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const EXPECTED_ROOT = "0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f";
const RUNTIME_LIMIT = 24_576;
const RUNTIME_WARNING = 23_500;
const INITCODE_LIMIT = 49_152;
const INITCODE_WARNING = 48_000;
const PRIVATE_KEY_PATTERN = /0x[0-9a-fA-F]{64}/g;

const [profileArg = "testnet-fast"] = process.argv.slice(2);
const profilePath = profileArg.endsWith(".json") ? profileArg : `config/contract-params.${profileArg}.json`;

function readText(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function exists(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return filePath;
}

function sourceConstant(source, type, name) {
  const pattern = new RegExp(`${type}\\s+public\\s+constant\\s+${name}\\s*=\\s*([^;]+);`);
  const match = source.match(pattern);
  if (!match) throw new Error(`missing source constant ${name}`);
  return match[1].trim();
}

function normalize(value) {
  return String(value).replace(/_/g, "").trim();
}

function bytecodeStats(name) {
  const artifact = readJson(`artifacts/${name}.json`);
  return {
    creationBytes: (artifact.bytecode.length - 2) / 2,
    runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
  };
}

function gitIgnored(filePath) {
  const result = spawnSync("git", ["check-ignore", "-q", filePath], { cwd: process.cwd() });
  return result.status === 0;
}

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files"], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function checkThreshold(kind, name, value, limit, warning, issues, warnings) {
  if (value >= limit) {
    issues.push(`${name} ${kind} is ${value} bytes, exceeding hard limit ${limit}`);
  } else if (value >= warning) {
    warnings.push(`${name} ${kind} is ${value} bytes, near warning threshold ${warning}`);
  }
}

function profileCheck() {
  const profile = readJson(profilePath);
  const source = readText("src/EternalBeings.sol");
  const constants = profile.constants || {};
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

  const actual = {};
  const mismatches = [];
  for (const [type, name] of entries) {
    if (constants[name] === undefined) continue;
    const sourceValue = sourceConstant(source, type, name);
    actual[name] = sourceValue;
    if (normalize(sourceValue) !== normalize(constants[name])) {
      mismatches.push({ name, expected: String(constants[name]), actual: sourceValue });
    }
  }
  return {
    profile: profile.profile || profileArg,
    profilePath,
    actual,
    mismatches,
    ok: mismatches.length === 0,
  };
}

function bytecodeCheck() {
  const contracts = {
    EternalBeings: bytecodeStats("EternalBeings"),
    EternalRenderer: bytecodeStats("EternalRenderer"),
  };
  const issues = [];
  const warnings = [];
  for (const [name, stats] of Object.entries(contracts)) {
    checkThreshold("runtime", name, stats.runtimeBytes, RUNTIME_LIMIT, RUNTIME_WARNING, issues, warnings);
    checkThreshold("initcode", name, stats.creationBytes, INITCODE_LIMIT, INITCODE_WARNING, issues, warnings);
  }
  return {
    contracts,
    limits: {
      eip170RuntimeBytes: RUNTIME_LIMIT,
      projectRuntimeWarningBytes: RUNTIME_WARNING,
      eip3860InitcodeBytes: INITCODE_LIMIT,
      projectInitcodeWarningBytes: INITCODE_WARNING,
    },
    warnings,
    issues,
    ok: issues.length === 0,
  };
}

function rootCheck() {
  const proofs = readJson("reports/top-collections.proofs.json");
  const deployment = readJson("reports/deployment-mainnet.json");
  const verify = readJson("reports/verify/verify-summary.json");
  const curated = readJson("data/top-collections.ethereum.curated.json");
  const roots = {
    proofs: proofs.root,
    deploymentMainnet: deployment.constructorArgs.topCollectionsRoot,
    verify: verify.constructorArgs.topCollectionsRoot,
  };
  const issues = [];
  for (const [name, value] of Object.entries(roots)) {
    if (String(value).toLowerCase() !== EXPECTED_ROOT) issues.push(`${name} root mismatch`);
  }
  if (proofs.count !== 100 || !Array.isArray(proofs.entries) || proofs.entries.length !== 100) {
    issues.push("proof file must contain exactly 100 collection entries");
  }
  if (!Array.isArray(curated) || curated.length !== 100) {
    issues.push("curated collection list must contain exactly 100 entries");
  }
  return {
    expectedRoot: EXPECTED_ROOT,
    roots,
    proofCount: proofs.count,
    curatedCount: Array.isArray(curated) ? curated.length : null,
    tiers: proofs.tiers,
    issues,
    ok: issues.length === 0,
  };
}

function secretHygieneCheck() {
  const requiredIgnoredPaths = [
    "reports/secrets/deployer.secrets.json",
    "reports/secrets/sepolia-clean-2-wallet-mint-cycle.secrets.json",
    "reports/deployment-sepolia-clean.json",
    "reports/sepolia-clean-2-wallet-mint-cycle.json",
    "reports/verify-sepolia-clean-game/standard-json-input.json",
    ".env",
  ];
  const ignoreResults = Object.fromEntries(requiredIgnoredPaths.map((filePath) => [filePath, gitIgnored(filePath)]));
  const issues = [];
  for (const [filePath, ignored] of Object.entries(ignoreResults)) {
    if (!ignored) issues.push(`${filePath} is not ignored by git`);
  }

  const example = readJson("config/deployer.secrets.example.json");
  const exampleKey = String(example.wallets?.[0]?.privateKey || "");
  if (PRIVATE_KEY_PATTERN.test(exampleKey)) {
    issues.push("config/deployer.secrets.example.json appears to contain a real private key");
  }
  PRIVATE_KEY_PATTERN.lastIndex = 0;

  const trackedSecretHits = [];
  for (const filePath of gitTrackedFiles()) {
    if (filePath.startsWith("node_modules/") || filePath.startsWith("artifacts/")) continue;
    const absolute = path.join(process.cwd(), filePath);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 1_000_000) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (content.match(PRIVATE_KEY_PATTERN)) trackedSecretHits.push(filePath);
    PRIVATE_KEY_PATTERN.lastIndex = 0;
  }
  if (trackedSecretHits.length > 0) {
    issues.push(`tracked files contain private-key-like 64-byte hex values: ${trackedSecretHits.join(", ")}`);
  }

  return {
    ignoredPaths: ignoreResults,
    trackedSecretHits,
    issues,
    ok: issues.length === 0,
  };
}

function scriptsAndDocsCheck() {
  const packageJson = readJson("package.json");
  const requiredScripts = [
    "test",
    "check-params",
    "mainnet-params-flow-test",
    "prelaunch-audit",
    "deploy:preflight",
    "deploy:from-secret",
    "sepolia-clean-rehearsal",
    "sepolia-mint-abuse-readonly-test",
    "sepolia-tier-proof-check",
    "validate-deployer-secret",
    "readiness-report",
  ];
  const requiredDocs = [
    "README.md",
    "CONTRACT_INTERACTION.md",
    "CONTRACT_PARAMS.md",
    "DEPLOYMENT_CHECKLIST.md",
    "TESTNET_QUICKSTART.md",
    "TESTNET_REHEARSAL.md",
    "AUDIT_NOTES.md",
  ];
  const requiredFiles = [
    "config/deployer.secrets.example.json",
    "config/contract-params.mainnet.json",
    "config/contract-params.testnet-fast.json",
    "scripts/deploy-from-secret.js",
    "scripts/deploy-preflight.js",
    "scripts/validate-deployer-secret.js",
  ];

  const issues = [];
  for (const script of requiredScripts) {
    if (!packageJson.scripts?.[script]) issues.push(`missing npm script: ${script}`);
  }
  for (const filePath of requiredDocs.concat(requiredFiles)) {
    try {
      exists(filePath);
    } catch (error) {
      issues.push(error.message);
    }
  }

  return {
    requiredScripts,
    requiredDocs,
    requiredFiles,
    issues,
    ok: issues.length === 0,
  };
}

function main() {
  const checks = {
    profile: profileCheck(),
    bytecode: bytecodeCheck(),
    collections: rootCheck(),
    secretHygiene: secretHygieneCheck(),
    scriptsAndDocs: scriptsAndDocsCheck(),
  };
  const issues = Object.entries(checks).flatMap(([name, check]) => (check.issues || check.mismatches || []).map((item) => ({ check: name, item })));
  const warnings = Object.entries(checks).flatMap(([name, check]) => (check.warnings || []).map((item) => ({ check: name, item })));
  const report = {
    generatedAt: new Date().toISOString(),
    profileArg,
    ok: issues.length === 0,
    issues,
    warnings,
    checks,
  };

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/prelaunch-audit.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
  console.log("prelaunch-audit ok");
}

main();
