const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  outputPath = "reports/sepolia-fast-v4-event-audit.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-event-audit.js <rpcUrl> <gameAddress> [outputPath]",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function txsFromReports() {
  const reports = [
    ["fusion", "reports/sepolia-fast-v4-fusion-test.json", (r) => [r.fusion.tx]],
    ["external-devour", "reports/sepolia-fast-v4-locked-nft-test.json", (r) => [r.external.devourTx]],
    ["hunt", "reports/sepolia-fast-v4-hunt-ore-smoke.json", (r) => [r.enter.tx, r.resolve.tx]],
    ["approval", "reports/sepolia-fast-v4-marketplace-approval-test.json", (r) => [
      r.approve.tx,
      r.approvedTransfer.tx,
      r.setApprovalForAll.tx,
      r.operatorTransfer.tx,
      r.clearApprovalForAll.tx,
    ]],
    ["mint", "reports/sepolia-fast-v4-2-wallet-mint-cycle.claim.json", (r) => (r.claims || []).map((c) => c.tx)],
  ];

  const out = [];
  for (const [label, path, pick] of reports) {
    if (!fs.existsSync(path)) continue;
    const report = readJson(path);
    for (const tx of pick(report).filter(Boolean)) out.push({ label, tx });
  }
  return out;
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const txs = txsFromReports();
  const transactions = [];
  const eventCounts = {};

  for (const entry of txs) {
    const receipt = await provider.getTransactionReceipt(entry.tx);
    const events = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== gameAddress.toLowerCase()) continue;
      try {
        const parsed = game.interface.parseLog(log);
        if (parsed) {
          events.push(parsed.name);
          eventCounts[parsed.name] = (eventCounts[parsed.name] || 0) + 1;
        }
      } catch {
        // Ignore unknown logs.
      }
    }
    transactions.push({
      label: entry.label,
      tx: entry.tx,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      events,
    });
  }

  const required = {
    Transfer: (eventCounts.Transfer || 0) > 0,
    Approval: (eventCounts.Approval || 0) > 0,
    ApprovalForAll: (eventCounts.ApprovalForAll || 0) > 0,
    MetadataUpdate: (eventCounts.MetadataUpdate || 0) > 0,
    BeingMinted: (eventCounts.BeingMinted || 0) > 0,
    Fused: (eventCounts.Fused || 0) > 0,
    Devoured: (eventCounts.Devoured || 0) > 0,
    HuntEntered: (eventCounts.HuntEntered || 0) > 0,
    HuntResolved: (eventCounts.HuntResolved || 0) > 0,
  };

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    transactions,
    eventCounts,
    required,
    ok: Object.values(required).every(Boolean),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
