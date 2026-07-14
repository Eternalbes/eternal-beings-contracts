const fs = require("fs");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const [
  rpcUrl,
  secretPath,
  deployerAddress,
  topCollectionsRoot,
  royaltyReceiver,
  outputPath = "reports/deployment-from-secret.json",
  profileArg = "",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/deploy-from-secret.js <rpcUrl> <secretPath> <deployerAddress> <topCollectionsRoot> <royaltyReceiver> [outputPath] [profile]",
      "",
      "The secret file must contain { wallets: [{ address, privateKey }] }.",
      "The private key is never printed.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function privateKeyFor(secretReport, address) {
  const lower = address.toLowerCase();
  const wallet = (secretReport.wallets || []).find((entry) => String(entry.address).toLowerCase() === lower);
  if (!wallet || !wallet.privateKey) throw new Error(`missing private key for ${address}`);
  return wallet.privateKey;
}

function isIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "-q", path], { cwd: process.cwd() });
  return result.status === 0;
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

async function main() {
  if (!rpcUrl || !secretPath || !deployerAddress || !topCollectionsRoot || !royaltyReceiver) {
    usage();
    process.exit(1);
  }
  if (royaltyReceiver.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("royaltyReceiver must be non-zero");
  }
  if (!isIgnored(secretPath)) {
    throw new Error(`secretPath is not ignored by git: ${secretPath}`);
  }
  const paramProfile = assertParamProfile(profileArg);
  for (const artifact of ["artifacts/EternalBeings.json", "artifacts/EternalRenderer.json"]) {
    if (!fs.existsSync(artifact)) throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const secrets = readJson(secretPath);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.NonceManager(new ethers.Wallet(privateKeyFor(secrets, deployerAddress), provider));
  const resolvedDeployer = await wallet.getAddress();
  if (resolvedDeployer.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`secret resolved to ${resolvedDeployer}, expected ${deployerAddress}`);
  }

  const [network, deployerBalance] = await Promise.all([provider.getNetwork(), provider.getBalance(resolvedDeployer)]);
  const gameArtifact = readJson("artifacts/EternalBeings.json");
  const rendererArtifact = readJson("artifacts/EternalRenderer.json");
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, wallet);
  const gameFactory = new ethers.ContractFactory(gameArtifact.abi, gameArtifact.bytecode, wallet);

  const renderer = await rendererFactory.deploy();
  const rendererReceipt = await renderer.deploymentTransaction().wait();
  const rendererAddress = await renderer.getAddress();
  const game = await gameFactory.deploy(topCollectionsRoot, royaltyReceiver, rendererAddress);
  const gameReceipt = await game.deploymentTransaction().wait();
  const gameAddress = await game.getAddress();
  const oreAddress = await game.ore();
  const finalBalance = await provider.getBalance(resolvedDeployer);

  const report = {
    createdAt: new Date().toISOString(),
    chainId: network.chainId.toString(),
    deployer: resolvedDeployer,
    topCollectionsRoot,
    royaltyReceiver,
    paramProfile,
    rendererAddress,
    gameAddress,
    oreAddress,
    rendererDeploymentTransaction: rendererReceipt.hash,
    gameDeploymentTransaction: gameReceipt.hash,
    rendererGasUsed: rendererReceipt.gasUsed.toString(),
    gameGasUsed: gameReceipt.gasUsed.toString(),
    totalGasUsed: (rendererReceipt.gasUsed + gameReceipt.gasUsed).toString(),
    deployerBalanceBefore: deployerBalance.toString(),
    deployerBalanceAfter: finalBalance.toString(),
    postDeployCheck: `node scripts/postdeploy-check.js <rpcUrl> ${gameAddress} ${topCollectionsRoot} ${royaltyReceiver}`,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
