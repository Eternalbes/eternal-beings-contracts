const fs = require("fs");
const { ethers } = require("ethers");

const inputPath = process.argv[2] || "data/top-collections.ethereum.curated.json";
const entries = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const seenRanks = new Set();
const seenAddresses = new Set();

for (const entry of entries) {
  if (!Number.isInteger(entry.rank) || entry.rank < 1) {
    throw new Error(`Invalid rank for ${entry.name}`);
  }
  if (seenRanks.has(entry.rank)) {
    throw new Error(`Duplicate rank ${entry.rank}`);
  }
  seenRanks.add(entry.rank);

  const address = ethers.getAddress(entry.address.toLowerCase());
  const lower = address.toLowerCase();
  if (seenAddresses.has(lower)) {
    throw new Error(`Duplicate address ${address}`);
  }
  seenAddresses.add(lower);

  const expectedTier = entry.rank <= 10 ? 5 : entry.rank <= 30 ? 4 : entry.rank <= 50 ? 3 : entry.rank <= 70 ? 2 : 1;
  if (entry.tier !== expectedTier) {
    throw new Error(`Rank ${entry.rank} should use tier ${expectedTier}, got ${entry.tier}`);
  }
}

console.log(`validated ${entries.length} tier entries`);
