const fs = require("fs");
const { spawnSync } = require("child_process");

const [
  secretPath,
  chainId,
  contractAddress,
  verifyDir = "reports/verify",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/etherscan-verify-from-secret.js <secretPath> <chainId> <contractAddress> [verifyDir]",
      "",
      "The secret file must contain { \"apiKey\": \"...\" }. The API key is never printed.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function isIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "-q", path], { cwd: process.cwd() });
  return result.status === 0;
}

function main() {
  if (!secretPath || !chainId || !contractAddress) {
    usage();
    process.exit(1);
  }
  if (!isIgnored(secretPath)) throw new Error(`secretPath is not ignored by git: ${secretPath}`);
  const secret = readJson(secretPath);
  const apiKey = String(secret.apiKey || "").trim();
  if (!apiKey || apiKey.includes("ETHERSCAN_API_KEY")) throw new Error(`missing apiKey in ${secretPath}`);

  const result = spawnSync(process.execPath, ["scripts/etherscan-verify.js", chainId, contractAddress, verifyDir], {
    cwd: process.cwd(),
    env: { ...process.env, ETHERSCAN_API_KEY: apiKey },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

main();
