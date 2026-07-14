const fs = require("fs");
const { spawnSync } = require("child_process");

const DEFAULT_RPC_URL = "https://ethereum.publicnode.com";
const DEFAULT_DEPLOYER = "0x7eb7c0d2fe5b3c35b34cd4c512b119c2167bb749";
const DEFAULT_ROYALTY_RECEIVER = DEFAULT_DEPLOYER;
const DEFAULT_ROOT = "0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f";
const DEFAULT_SECRET_PATH = "reports/secrets/deployer.secrets.json";
const DEFAULT_ETHERSCAN_SECRET_PATH = "reports/secrets/etherscan.secrets.json";
const DEFAULT_DEPLOYMENT_REPORT = "reports/deployment-mainnet-live.json";
const DEFAULT_SUMMARY_REPORT = "reports/mainnet-one-click-deploy.json";
const MAINNET_CHAIN_ID = "1";

function usage() {
  console.error(
    [
      "Usage:",
      "  npm run deploy:mainnet:one-click -- --confirm-mainnet-deploy",
      "",
      "Options:",
      "  --confirm-mainnet-deploy     Required for real mainnet deployment.",
      "  --dry-run                    Run through preflight only; does not deploy.",
      "  --rpc <url>                  Mainnet RPC URL. Default: ethereum.publicnode.com",
      "  --deployer <address>         Deployer address.",
      "  --royalty <address>          ERC2981 royalty receiver.",
      "  --root <bytes32>             Top 100 NFT collection Merkle root.",
      "  --secret <path>              Ignored deployer secret JSON.",
      "  --etherscan-secret <path>    Ignored Etherscan secret JSON.",
      "  --out <path>                 Deployment report path.",
      "  --summary <path>             One-click summary report path.",
      "  --skip-verify                Skip Etherscan verification.",
      "  --skip-restore               Leave local source/artifacts on mainnet params.",
      "",
      "The script prints Game, Renderer, and ORE addresses after deployment.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    confirm: false,
    dryRun: false,
    rpcUrl: process.env.MAINNET_RPC_URL || DEFAULT_RPC_URL,
    deployer: process.env.MAINNET_DEPLOYER || DEFAULT_DEPLOYER,
    royaltyReceiver: process.env.ROYALTY_RECEIVER || DEFAULT_ROYALTY_RECEIVER,
    root: process.env.TOP_COLLECTIONS_ROOT || DEFAULT_ROOT,
    secretPath: process.env.DEPLOYER_SECRET_PATH || DEFAULT_SECRET_PATH,
    etherscanSecretPath: process.env.ETHERSCAN_SECRET_PATH || DEFAULT_ETHERSCAN_SECRET_PATH,
    deploymentReport: DEFAULT_DEPLOYMENT_REPORT,
    summaryReport: DEFAULT_SUMMARY_REPORT,
    skipVerify: false,
    restoreProfile: "testnet-fast",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-mainnet-deploy") args.confirm = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skip-verify") args.skipVerify = true;
    else if (arg === "--skip-restore") args.restoreProfile = "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--rpc") args.rpcUrl = requiredValue(argv, ++i, arg);
    else if (arg === "--deployer") args.deployer = requiredValue(argv, ++i, arg);
    else if (arg === "--royalty") args.royaltyReceiver = requiredValue(argv, ++i, arg);
    else if (arg === "--root") args.root = requiredValue(argv, ++i, arg);
    else if (arg === "--secret") args.secretPath = requiredValue(argv, ++i, arg);
    else if (arg === "--etherscan-secret") args.etherscanSecretPath = requiredValue(argv, ++i, arg);
    else if (arg === "--out") args.deploymentReport = requiredValue(argv, ++i, arg);
    else if (arg === "--summary") args.summaryReport = requiredValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function runStep(name, commandArgs, options = {}) {
  console.log(`\n=== ${name} ===`);
  console.log(commandArgs.join(" "));
  const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status || 1}`);
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function deploymentAddresses(reportPath) {
  const report = readJson(reportPath);
  return {
    gameAddress: report.gameAddress,
    rendererAddress: report.rendererAddress,
    oreAddress: report.oreAddress,
    gameDeploymentTransaction: report.gameDeploymentTransaction,
    rendererDeploymentTransaction: report.rendererDeploymentTransaction,
  };
}

function printAddresses(addresses) {
  console.log("\n=== MAINNET CONTRACTS ===");
  console.log(`Game:     ${addresses.gameAddress || "(not deployed)"}`);
  console.log(`Renderer: ${addresses.rendererAddress || "(not deployed)"}`);
  console.log(`ORE:      ${addresses.oreAddress || "(not deployed)"}`);
  if (addresses.gameDeploymentTransaction) {
    console.log(`Game tx:  ${addresses.gameDeploymentTransaction}`);
  }
  if (addresses.rendererDeploymentTransaction) {
    console.log(`Renderer tx: ${addresses.rendererDeploymentTransaction}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.dryRun && !args.confirm) {
    usage();
    throw new Error("refusing to send mainnet transactions without --confirm-mainnet-deploy");
  }

  const node = process.execPath;
  const summary = {
    createdAt: new Date().toISOString(),
    mode: args.dryRun ? "dry-run" : "mainnet-deploy",
    rpcUrl: args.rpcUrl,
    deployer: args.deployer,
    royaltyReceiver: args.royaltyReceiver,
    topCollectionsRoot: args.root,
    secretPath: args.secretPath,
    etherscanSecretPath: args.etherscanSecretPath,
    deploymentReport: args.deploymentReport,
    restoreProfile: args.restoreProfile || null,
    steps: [],
    addresses: null,
    ok: false,
  };

  let postDeployError = null;
  let restoreError = null;

  try {
    runStep("apply mainnet params", [node, "scripts/apply-contract-params.js", "mainnet"]);
    summary.steps.push("apply-mainnet-params");

    runStep("compile mainnet artifacts", [node, "scripts/compile.js"], { env: { WRITE_ARTIFACTS: "1" } });
    summary.steps.push("compile");

    runStep("check mainnet params", [node, "scripts/check-contract-params.js", "mainnet"]);
    summary.steps.push("check-mainnet-params");

    runStep("prelaunch audit", [node, "scripts/prelaunch-audit.js", "mainnet"]);
    summary.steps.push("prelaunch-audit");

    runStep("validate deployer secret", [
      node,
      "scripts/validate-deployer-secret.js",
      args.rpcUrl,
      args.secretPath,
      args.deployer,
      "0",
    ]);
    summary.steps.push("validate-deployer-secret");

    runStep("mainnet preflight", [
      node,
      "scripts/deploy-preflight.js",
      args.rpcUrl,
      args.deployer,
      args.root,
      args.royaltyReceiver,
      "reports/mainnet-deploy-preflight.json",
      "",
      "mainnet",
    ]);
    summary.steps.push("mainnet-preflight");

    if (args.dryRun) {
      summary.ok = true;
      writeJson(args.summaryReport, summary);
      console.log(`\ndry-run ok. Summary: ${args.summaryReport}`);
      return;
    }

    runStep("deploy mainnet contracts", [
      node,
      "scripts/deploy-from-secret.js",
      args.rpcUrl,
      args.secretPath,
      args.deployer,
      args.root,
      args.royaltyReceiver,
      args.deploymentReport,
      "mainnet",
    ]);
    summary.steps.push("deploy-mainnet-contracts");
    summary.addresses = deploymentAddresses(args.deploymentReport);
    printAddresses(summary.addresses);

    try {
      runStep("postdeploy check", [
        node,
        "scripts/postdeploy-check.js",
        args.rpcUrl,
        summary.addresses.gameAddress,
        args.root,
        args.royaltyReceiver,
      ]);
      summary.steps.push("postdeploy-check");

      if (!args.skipVerify) {
        runStep("prepare renderer verify", [node, "scripts/prepare-renderer-verify.js", "reports/verify-mainnet-renderer"]);
        summary.steps.push("prepare-renderer-verify");

        runStep("verify renderer", [
          node,
          "scripts/etherscan-verify-from-secret.js",
          args.etherscanSecretPath,
          MAINNET_CHAIN_ID,
          summary.addresses.rendererAddress,
          "reports/verify-mainnet-renderer",
        ]);
        summary.steps.push("verify-renderer");

        runStep("prepare game verify", [
          node,
          "scripts/prepare-verify.js",
          args.root,
          args.royaltyReceiver,
          summary.addresses.rendererAddress,
          "reports/verify-mainnet-game",
        ]);
        summary.steps.push("prepare-game-verify");

        runStep("verify game", [
          node,
          "scripts/etherscan-verify-from-secret.js",
          args.etherscanSecretPath,
          MAINNET_CHAIN_ID,
          summary.addresses.gameAddress,
          "reports/verify-mainnet-game",
        ]);
        summary.steps.push("verify-game");

        runStep("prepare ore verify", [
          node,
          "scripts/prepare-ore-verify.js",
          summary.addresses.gameAddress,
          "reports/verify-mainnet-ore",
        ]);
        summary.steps.push("prepare-ore-verify");

        runStep("verify ore", [
          node,
          "scripts/etherscan-verify-from-secret.js",
          args.etherscanSecretPath,
          MAINNET_CHAIN_ID,
          summary.addresses.oreAddress,
          "reports/verify-mainnet-ore",
        ]);
        summary.steps.push("verify-ore");
      }
    } catch (error) {
      postDeployError = error;
      summary.postDeployError = error.message;
    }

    summary.ok = !postDeployError;
  } finally {
    if (args.restoreProfile) {
      try {
        runStep(`restore ${args.restoreProfile} params`, [node, "scripts/apply-contract-params.js", args.restoreProfile]);
        runStep(`compile ${args.restoreProfile} artifacts`, [node, "scripts/compile.js"], {
          env: { WRITE_ARTIFACTS: "1" },
        });
        summary.restoredProfile = args.restoreProfile;
      } catch (error) {
        restoreError = error;
        summary.restoreError = error.message;
        summary.ok = false;
      }
    }
    writeJson(args.summaryReport, summary);
    if (summary.addresses) printAddresses(summary.addresses);
    console.log(`\nSummary report: ${args.summaryReport}`);
  }

  if (postDeployError) throw postDeployError;
  if (restoreError) throw restoreError;
}

main();
