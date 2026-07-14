const fs = require("fs");
const { ethers } = require("ethers");
const { buildTree, leafFor } = require("./merkle");

const proofPath = process.argv[2] || "reports/top-collections.proofs.json";
const expectedRoot = process.argv[3] || "";

function verifyProof(proof, root, leaf) {
  let computed = leaf;
  for (const proofElement of proof) {
    computed =
      BigInt(computed) <= BigInt(proofElement)
        ? ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [computed, proofElement]))
        : ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [proofElement, computed]));
  }
  return computed.toLowerCase() === root.toLowerCase();
}

function main() {
  if (!fs.existsSync(proofPath)) throw new Error(`Missing proof file: ${proofPath}`);
  const proofFile = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  if (expectedRoot && proofFile.root.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error(`Root mismatch: expected ${expectedRoot}, got ${proofFile.root}`);
  }

  const entries = proofFile.entries.map(({ proof, index, ...entry }) => entry);
  const rebuilt = buildTree(entries);
  if (rebuilt.root.toLowerCase() !== proofFile.root.toLowerCase()) {
    throw new Error(`Rebuilt root mismatch: expected ${proofFile.root}, got ${rebuilt.root}`);
  }

  for (const entry of proofFile.entries) {
    const leaf = leafFor(entry.address, entry.tier);
    if (!verifyProof(entry.proof, proofFile.root, leaf)) {
      throw new Error(`Invalid proof for ${entry.name || entry.address}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        proofPath,
        root: proofFile.root,
        count: proofFile.entries.length,
        tiers: proofFile.tiers,
      },
      null,
      2,
    ),
  );
  console.log("verify-proof-file ok");
}

main();
