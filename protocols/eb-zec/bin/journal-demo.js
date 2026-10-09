const fs = require("node:fs");
const path = require("node:path");
const { SqliteJournal } = require("../storage/sqlite-journal");
const { buildDemo } = require("./demo");
const { canonical, ensure } = require("../lib/crypto");

function journalDemo(name = "journal-demo.sqlite") {
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.sqlite$/.test(name), "INVALID_JOURNAL_NAME");
  const directory = path.resolve(__dirname, "../local");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensure(!fs.lstatSync(directory).isSymbolicLink(), "UNSAFE_JOURNAL_DIRECTORY");
  const file = path.join(directory, name);
  const { c } = buildDemo();
  const journal = SqliteJournal.create(file, c.manifest);
  try { journal.append(c.blocks); } finally { journal.close(); }
  const recovered = new SqliteJournal(file, { readOnly: true });
  try {
    const snapshot = recovered.snapshot();
    ensure(canonical(snapshot) === canonical(c.indexer.snapshot()), "JOURNAL_REPLAY_MISMATCH");
    return { status: "local-journal-recovery-passed", file, revision: recovered.revision,
      observed_height: snapshot.observed_height, root: snapshot.root, minted: snapshot.state.minted_total,
      active: snapshot.state.live_supply, consumed: snapshot.state.consumed_total,
      source_kind: "local-fixture", real_zcash_integration: false, recovered_identically: true };
  } finally { recovered.close(); }
}

if (require.main === module) try { console.log(JSON.stringify(journalDemo(process.argv[2]), null, 2)); }
catch (error) { console.error(error.code || "JOURNAL_DEMO_FAILED"); process.exitCode = 1; }
module.exports = { journalDemo };
