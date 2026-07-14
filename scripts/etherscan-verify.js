const fs = require("fs");

const API_URL = "https://api.etherscan.io/v2/api";

const chainId = process.argv[2] || "";
const contractAddress = process.argv[3] || "";
const verifyDir = process.argv[4] || "reports/verify";
const apiKey = process.env.ETHERSCAN_API_KEY || "";

function usage() {
  console.error(
    [
      "Usage:",
      "  ETHERSCAN_API_KEY=... node scripts/etherscan-verify.js <chainId> <contractAddress> [verifyDir]",
      "",
      "Example:",
      "  ETHERSCAN_API_KEY=... node scripts/etherscan-verify.js 11155111 0xGame... reports/verify-sepolia",
    ].join("\n"),
  );
}

function requireFile(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return fs.readFileSync(path, "utf8").trim();
}

async function post(params) {
  const query = new URLSearchParams();
  for (const key of ["apikey", "chainid", "module", "action"]) {
    if (params[key]) query.set(key, params[key]);
  }

  const bodyParams = { ...params };
  for (const key of ["apikey", "chainid", "module", "action"]) {
    delete bodyParams[key];
  }

  const body = new URLSearchParams(bodyParams);
  const response = await fetch(`${API_URL}?${query.toString()}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-json etherscan response: ${text}`);
  }
}

function compilerVersion(summary) {
  const version = summary.compilerVersion.replace(/\.Emscripten\.clang$/, "");
  return version.startsWith("v") ? version : `v${version}`;
}

async function pollStatus(guid) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 5000 : 10000));
    const status = await post({
      apikey: apiKey,
      chainid: chainId,
      module: "contract",
      action: "checkverifystatus",
      guid,
    });

    console.log(JSON.stringify({ attempt, status }, null, 2));
    if (status.status === "1" || /verified/i.test(status.result || "")) return status;
    if (!/pending|in queue|unable to locate/i.test(status.result || "")) return status;
  }

  return { status: "0", message: "TIMEOUT", result: "verification status polling timed out" };
}

async function main() {
  if (!apiKey || !chainId || !contractAddress) {
    usage();
    process.exit(1);
  }

  const summary = JSON.parse(requireFile(`${verifyDir}/verify-summary.json`));
  const sourceCode = requireFile(`${verifyDir}/standard-json-input.json`);
  const constructorArguments = requireFile(`${verifyDir}/constructor-args.txt`);

  const submission = await post({
    apikey: apiKey,
    chainid: chainId,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: contractAddress,
    sourceCode,
    codeformat: "solidity-standard-json-input",
    contractname: summary.fullyQualifiedName,
    compilerversion: compilerVersion(summary),
    optimizationUsed: summary.optimizer.enabled ? "1" : "0",
    runs: String(summary.optimizer.runs),
    constructorArguments,
    evmVersion: summary.evmVersion,
    licenseType: "3",
  });

  console.log(JSON.stringify({ submission }, null, 2));

  if (submission.status !== "1") {
    process.exitCode = 1;
    return;
  }

  const finalStatus = await pollStatus(submission.result);
  fs.writeFileSync(
    `${verifyDir}/etherscan-verify-result.json`,
    `${JSON.stringify({ submittedAt: new Date().toISOString(), submission, finalStatus }, null, 2)}\n`,
  );

  if (finalStatus.status !== "1" && !/verified/i.test(finalStatus.result || "")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
