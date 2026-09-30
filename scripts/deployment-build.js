const fs = require("fs");
const { ethers } = require("ethers");
const solc = require("solc");

function sourceFingerprint(sources) {
  function readTree(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? readTree(file) : file.endsWith(".sol") ? [file] : [];
    }).sort();
  }
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    compiler: solc.version(),
    compileScript: fs.readFileSync("scripts/compile.js", "utf8"),
    sources: sources
      ? Object.keys(sources).sort().map((file) => [file, sources[file].content])
      : readTree("src").map((file) => [file, fs.readFileSync(file, "utf8")]),
  })));
}

function loadBuild(names) {
  const fingerprint = sourceFingerprint();
  const artifacts = Object.fromEntries(names.map((name) => {
    const artifact = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
    if (artifact.sourceFingerprint !== fingerprint) {
      throw new Error(`stale build for ${name}; compile with WRITE_ARTIFACTS=1 first`);
    }
    return [name, artifact];
  }));
  const buildId = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(artifacts)));
  return { artifacts, buildId };
}

function assertBuild(report, buildId) {
  if (report.buildId !== buildId) throw new Error("deployment build mismatch; old reports cannot resume a new build");
}

async function verifyDeployment(provider, saved, expectedInitCode, expectedDeployer) {
  const initCodeHash = ethers.keccak256(expectedInitCode);
  if (saved.initCodeHash !== initCodeHash) throw new Error("deployment constructor or bytecode mismatch");
  const receipt = await provider.waitForTransaction(saved.transactionHash, 1, 120_000);
  if (!receipt || receipt.status !== 1 || receipt.contractAddress?.toLowerCase() !== saved.address.toLowerCase()) {
    throw new Error("deployment receipt/address mismatch");
  }
  const transaction = await provider.getTransaction(saved.transactionHash);
  if (!transaction || transaction.to !== null
      || transaction.from.toLowerCase() !== expectedDeployer.toLowerCase()
      || ethers.keccak256(transaction.data) !== initCodeHash) {
    throw new Error("deployment transaction does not match the expected build and constructor");
  }
  const code = await provider.getCode(saved.address);
  if (code === "0x") throw new Error("deployment has no runtime code");
  const runtimeCodeHash = ethers.keccak256(code);
  if (saved.runtimeCodeHash && saved.runtimeCodeHash !== runtimeCodeHash) {
    throw new Error("deployment runtime code mismatch");
  }
  return { receipt, runtimeCodeHash };
}

module.exports = { sourceFingerprint, loadBuild, assertBuild, verifyDeployment };
