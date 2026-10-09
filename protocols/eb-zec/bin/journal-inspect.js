const { SqliteJournal } = require("../storage/sqlite-journal");
const { ensure } = require("../lib/crypto");

if (require.main === module) try {
  ensure(process.argv.length === 3, "USAGE_JOURNAL_INSPECT_FILE");
  const journal = new SqliteJournal(process.argv[2], { readOnly: true });
  try {
    const snapshot = journal.snapshot();
    console.log(JSON.stringify({ source_kind: "local-fixture", real_zcash_integration: false,
      recovery_verified: true, revision: journal.revision, observed_height: snapshot.observed_height,
      finalized_height: snapshot.finalized_height, root: snapshot.root,
      minted: snapshot.state.minted_total, active: snapshot.state.live_supply,
      consumed: snapshot.state.consumed_total }, null, 2));
  } finally { journal.close(); }
} catch (error) { console.error(error.code || "JOURNAL_INSPECTION_FAILED"); process.exitCode = 1; }
