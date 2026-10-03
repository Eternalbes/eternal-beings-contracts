const fs = require("node:fs");
const { loadFixture } = require("../lib/fixture");
const { canonical } = require("../lib/crypto");

try {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npm run replay -- <local-fixture.json> [snapshot.json]");
  const { indexer } = loadFixture(file);
  const encoded = canonical(indexer.snapshot());
  if (process.argv[3]) fs.writeFileSync(process.argv[3],encoded+"\n",{ flag:"wx" });
  else console.log(encoded);
} catch(error) { console.error(error.code || error.message);process.exitCode=1; }
