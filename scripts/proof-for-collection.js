const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/proof-for-collection.js <collectionAddress> [proofFile]",
      "",
      "Default proofFile: reports/top-collections.proofs.json",
    ].join("\n"),
  );
}

function main() {
  const [collectionAddress, proofFile = "reports/top-collections.proofs.json"] = process.argv.slice(2);
  if (!collectionAddress) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(proofFile)) throw new Error(`Missing proof file: ${proofFile}`);

  const wanted = ethers.getAddress(collectionAddress.toLowerCase()).toLowerCase();
  const proofData = JSON.parse(fs.readFileSync(proofFile, "utf8"));
  const entry = proofData.entries.find((item) => ethers.getAddress(item.address.toLowerCase()).toLowerCase() === wanted);
  if (!entry) {
    throw new Error(`Collection not found in proof file: ${collectionAddress}`);
  }

  console.log(
    JSON.stringify(
      {
        root: proofData.root,
        index: entry.index,
        rank: entry.rank,
        name: entry.name,
        address: ethers.getAddress(entry.address.toLowerCase()),
        tier: entry.tier,
        proof: entry.proof,
        devourTieredExternalArgs: {
          nft: ethers.getAddress(entry.address.toLowerCase()),
          tier: entry.tier,
          proof: entry.proof,
        },
      },
      null,
      2,
    ),
  );
}

main();
