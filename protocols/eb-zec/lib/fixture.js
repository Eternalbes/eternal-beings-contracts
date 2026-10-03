const fs = require("node:fs");
const { Indexer } = require("./indexer");
const { ensure } = require("./crypto");

function loadFixture(file) {
  ensure(fs.statSync(file).size <= 32 * 1024 * 1024, "FIXTURE_TOO_LARGE");
  const fixture = JSON.parse(fs.readFileSync(file,"utf8"));
  ensure(fixture.source_kind === "local-fixture" && fixture.format === "eb-zec-local-chain-v1", "UNTRUSTED_SOURCE_FORMAT");
  const indexer = new Indexer(fixture.manifest);
  indexer.append(fixture.blocks);
  return { fixture, indexer };
}

module.exports = { loadFixture };
