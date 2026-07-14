const fs = require("fs");
const { spawnSync } = require("child_process");

const [
  rpcUrl,
  deploymentPath = "reports/deployment-sepolia-clean.json",
  deployerSecretPath = "reports/secrets/deployer.secrets.json",
  prefix = "reports/sepolia-clean",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-clean-rehearsal.js <rpcUrl> [deploymentPath] [deployerSecretPath] [prefix]",
      "",
      "Runs postdeploy, verify prep, 2-wallet mint, post-mint smoke, and marketplace metadata compatibility.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function privateKeyFor(secretReport, address) {
  const lower = address.toLowerCase();
  const match = (secretReport.wallets || []).find((entry) => String(entry.address).toLowerCase() === lower);
  if (!match || !match.privateKey) throw new Error(`missing private key for ${address}`);
  return match.privateKey;
}

function runStep(label, args, env = {}) {
  console.log(JSON.stringify({ step: label, command: ["node", ...args] }, null, 2));
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
}

function main() {
  if (!rpcUrl) {
    usage();
    process.exit(1);
  }

  const deployment = readJson(deploymentPath);
  const secrets = readJson(deployerSecretPath);
  const gameAddress = deployment.gameAddress;
  const rendererAddress = deployment.rendererAddress;
  const root = deployment.topCollectionsRoot;
  const royaltyReceiver = deployment.royaltyReceiver;
  const deployer = deployment.deployer;
  if (!gameAddress || !rendererAddress || !root || !royaltyReceiver || !deployer) {
    throw new Error("deployment report is missing gameAddress, rendererAddress, topCollectionsRoot, royaltyReceiver, or deployer");
  }
  const funderPrivateKey = privateKeyFor(secrets, deployer);
  const mintReport = `${prefix}-2-wallet-mint-cycle.json`;
  const mintSecrets = `${prefix}-2-wallet-mint-cycle.secrets.json`.replace("/sepolia-clean-", "/secrets/sepolia-clean-");

  runStep("postdeploy-check", ["scripts/postdeploy-check.js", rpcUrl, gameAddress, root, royaltyReceiver]);
  runStep("prepare-verify", ["scripts/prepare-verify.js", root, royaltyReceiver, rendererAddress, "reports/verify-sepolia-clean-game"]);
  runStep("mint-cycle", ["scripts/sepolia-fast-mint-cycle-robust.js", rpcUrl, gameAddress, "2", mintReport], {
    PRIVATE_KEY: funderPrivateKey,
  });
  runStep("post-mint-smoke", ["scripts/sepolia-post-mint-smoke.js", rpcUrl, gameAddress, mintReport, "2"]);
  runStep("marketplace-compat", [
    "scripts/sepolia-marketplace-compat-test.js",
    rpcUrl,
    gameAddress,
    mintReport,
    mintSecrets,
    `${prefix}-marketplace-compat.json`,
  ]);

  console.log(
    JSON.stringify(
      {
        status: "sepolia-clean-rehearsal ok",
        deploymentPath,
        gameAddress,
        rendererAddress,
        mintReport,
        mintSecrets,
        marketplaceReport: `${prefix}-marketplace-compat.json`,
      },
      null,
      2,
    ),
  );
}

main();
