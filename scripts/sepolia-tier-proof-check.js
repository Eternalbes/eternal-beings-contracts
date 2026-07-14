const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  proofPath = "reports/top-collections.proofs.json",
  outputPath = "reports/sepolia-tier-proof-check.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-tier-proof-check.js <rpcUrl> <gameAddress> [proofPath] [outputPath]",
      "",
      "Checks real top-collection Merkle proofs against a deployed game contract.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  const proofData = readJson(proofPath);
  const artifact = readJson("artifacts/EternalBeings.json");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const root = await game.topCollectionsRoot();
  if (root.toLowerCase() !== proofData.root.toLowerCase()) {
    throw new Error(`root mismatch: chain ${root}, file ${proofData.root}`);
  }

  const sampleRanks = [1, 10, 11, 30, 31, 50, 51, 70, 71, 100];
  const samples = [];
  for (const rank of sampleRanks) {
    const entry = proofData.entries.find((item) => Number(item.rank) === rank);
    if (!entry) throw new Error(`missing rank ${rank}`);
    const address = ethers.getAddress(entry.address.toLowerCase());
    const correct = await game.verifyCollectionTier(address, entry.tier, entry.proof);
    const wrongTier = entry.tier === 5 ? 4 : entry.tier + 1;
    const wrongTierAccepted = await game.verifyCollectionTier(address, wrongTier, entry.proof);
    const truncatedProofAccepted = await game.verifyCollectionTier(address, entry.tier, entry.proof.slice(0, -1));
    samples.push({
      rank: entry.rank,
      name: entry.name,
      address,
      tier: entry.tier,
      correct,
      wrongTier,
      wrongTierAccepted,
      truncatedProofAccepted,
    });
  }

  const unknownAddress = "0x000000000000000000000000000000000000dEaD";
  const nonMemberAccepted = await game.verifyCollectionTier(unknownAddress, 1, proofData.entries[0].proof);
  const nutrition = {};
  for (const tier of [0, 1, 2, 3, 4, 5]) {
    const value = await game.nutritionForTier(tier);
    nutrition[tier] = {
      massGain: value[0].toString(),
      complexityGain: value[1].toString(),
    };
  }

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    proofPath,
    root,
    samples,
    nonMember: {
      address: unknownAddress,
      accepted: nonMemberAccepted,
    },
    nutrition,
    ok:
      samples.every((sample) => sample.correct && !sample.wrongTierAccepted && !sample.truncatedProofAccepted) &&
      !nonMemberAccepted,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
