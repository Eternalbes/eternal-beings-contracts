const fs = require("fs");
const { buildTree, proofFor } = require("./merkle");

const inputPath = process.argv[2] || "data/top-collections.sample.json";
const outPath = process.argv[3] || "";
const entries = JSON.parse(fs.readFileSync(inputPath, "utf8"));

for (const entry of entries) {
  if (!entry.address || !entry.tier) {
    throw new Error("Each entry must include address and tier");
  }
}

const tree = buildTree(entries);
const tiers = {};
for (const entry of entries) {
  tiers[entry.tier] = (tiers[entry.tier] || 0) + 1;
}

const output = {
  generatedAt: new Date().toISOString(),
  inputPath,
  root: tree.root,
  count: entries.length,
  tiers,
  entries: entries.map((entry, index) => ({
    index,
    ...entry,
    proof: proofFor(index, tree.layers),
  })),
};

const json = JSON.stringify(output, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, `${json}\n`);
} else {
  console.log(json);
}
