const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { SqliteJournal } = require("../storage/sqlite-journal");
const { buildDemo } = require("../bin/demo");
const { makeManifest, start, block } = require("./helpers");
const { Indexer } = require("../lib/indexer");
const { canonical, hash } = require("../lib/crypto");

function setup(t, context = start()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebz-journal-test-"));
  const file = path.join(directory, "chain.sqlite");
  const journal = SqliteJournal.create(file, context.manifest);
  t.after(() => { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  journal.append(context.blocks);
  return { file, journal, context, directory };
}
function alter(file, work) {
  const db = new DatabaseSync(file);
  try { work(db); } finally { db.close(); }
}

test("journal reopens Mint, Hunt, fusion, devour and rejection state identically", t => {
  const { c } = buildDemo();
  const { file, journal } = setup(t, c);
  assert.equal(canonical(journal.snapshot()), canonical(c.indexer.snapshot()));
  assert.equal(journal.snapshot().state.minted_total, 3);
  assert.equal(journal.snapshot().state.live_supply, 1);
  assert.equal(journal.snapshot().state.consumed_total, 2);
  assert.equal(journal.revision, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  journal.close();
  const recovered = new SqliteJournal(file, { readOnly: true });
  try {
    assert.equal(canonical(recovered.snapshot()), canonical(c.indexer.snapshot()));
    assert.equal(recovered.revision, 1);
  } finally { recovered.close(); }
});

test("reorganization rolls back consumed sacrifices and rewards, then replays a fork", t => {
  const { c } = buildDemo();
  const { file, journal } = setup(t, c);
  const fork = [block(c.blocks[5], [], "alternate")];
  fork.push(block(fork[0], [], "alternate"));
  const expected = new Indexer(c.manifest);
  expected.append(c.blocks.slice(0, 6).concat(fork));
  journal.replaceFrom(6, fork);
  assert.equal(canonical(journal.snapshot()), canonical(expected.snapshot()));
  assert.equal(journal.snapshot().state.live_supply, 3);
  assert.equal(journal.snapshot().state.consumed_total, 0);
  assert.equal(journal.snapshot().state.issued_resource_units, 0);
  const recovered = new SqliteJournal(file);
  try { assert.equal(canonical(recovered.snapshot()), canonical(expected.snapshot())); }
  finally { recovered.close(); }
});

test("failed append/reorg leaves disk, revision and in-memory state unchanged", t => {
  const { file, journal, context } = setup(t);
  const before = canonical(journal.snapshot());
  const invalid = { ...block(context.blocks.at(-1)), parent_hash: "f".repeat(64) };
  assert.throws(() => journal.append([invalid]));
  assert.throws(() => journal.replaceFrom(-1, []));
  assert.equal(canonical(journal.snapshot()), before);
  assert.equal(journal.revision, 1);
  const recovered = new SqliteJournal(file);
  try { assert.equal(canonical(recovered.snapshot()), before); assert.equal(recovered.revision, 1); }
  finally { recovered.close(); }
});

test("SQL failures after deleting or inserting a fork suffix roll back the entire revision", t => {
  const { file, journal, context } = setup(t, buildDemo().c);
  const before = canonical(journal.snapshot());
  const original = DatabaseSync.prototype.prepare;
  for (const prefix of ["INSERT INTO journal_blocks", "UPDATE journal_meta SET revision"]) {
    const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function(sql, ...args) {
      if (sql.startsWith(prefix)) return { run() { throw new Error("INJECTED_STORAGE_FAILURE"); } };
      return original.call(this, sql, ...args);
    });
    try {
      assert.throws(() => journal.replaceFrom(6, [block(context.blocks[5], [], "failed-fork")]),
        { message: "INJECTED_STORAGE_FAILURE" });
      assert.equal(journal.revision, 1);
      assert.equal(canonical(journal.snapshot()), before);
    } finally { mocked.mock.restore(); }
    const recovered = new SqliteJournal(file);
    try { assert.equal(canonical(recovered.snapshot()), before); assert.equal(recovered.revision, 1); }
    finally { recovered.close(); }
  }
});

test("stale writers cannot overwrite a committed append until explicitly refreshed", t => {
  const { file, journal, context } = setup(t);
  const other = new SqliteJournal(file);
  try {
    const first = block(context.blocks.at(-1), [], "writer-a");
    journal.append([first]);
    assert.throws(() => other.append([block(context.blocks.at(-1), [], "writer-b")]), { code: "STALE_JOURNAL_WRITER" });
    other.refresh();
    other.append([block(first, [], "writer-b")]);
    journal.refresh();
    assert.equal(canonical(journal.snapshot()), canonical(other.snapshot()));
    assert.equal(journal.revision, 3);
  } finally { other.close(); }
});

test("read-only journal denies writes and snapshots do not expose mutable internals", t => {
  const { file, journal, context } = setup(t);
  const before = canonical(journal.snapshot());
  const exposed = journal.snapshot();
  exposed.manifest.max_supply = 1;
  exposed.state.minted_total = 999;
  assert.equal(canonical(journal.snapshot()), before);
  const apiIndexer = journal.replayIndexer();
  assert.equal(canonical(apiIndexer.snapshot()), before);
  apiIndexer.state.minted_total = 999;
  assert.equal(canonical(journal.snapshot()), before);
  const readonly = new SqliteJournal(file, { readOnly: true });
  try {
    assert.throws(() => readonly.append([block(context.blocks.at(-1))]), { code: "JOURNAL_READ_ONLY" });
    assert.equal(canonical(readonly.snapshot()), before);
  } finally { readonly.close(); }
  assert.throws(() => readonly.snapshot(), { code: "JOURNAL_CLOSED" });
});

test("reorganization can truncate all blocks and then restore genesis", t => {
  const { journal, context } = setup(t);
  journal.replaceFrom(context.manifest.genesis_height, []);
  assert.equal(journal.snapshot().observed_height, -1);
  journal.append(context.blocks);
  assert.equal(canonical(journal.snapshot()), canonical(context.indexer.snapshot()));
});

test("unconfirmed tail is stored without applying premature state changes", t => {
  const context = start({ confirmation_depth: 3 });
  const { journal } = setup(t, context);
  assert.equal(journal.snapshot().finalized_height, -1);
  const second = block(context.blocks[0]);
  journal.append([second, block(second)]);
  const expected = new Indexer(context.manifest);
  expected.append(context.blocks.concat([second, block(second)]));
  assert.equal(canonical(journal.snapshot()), canonical(expected.snapshot()));
  assert.equal(journal.snapshot().finalized_height, 0);
});

test("altered canonical block records are rejected on recovery", t => {
  const { file, journal } = setup(t);
  journal.close();
  alter(file, db => db.prepare("UPDATE journal_blocks SET block_json = ? WHERE height = 0").run('{"height":0}'));
  assert.throws(() => new SqliteJournal(file), { code: "JOURNAL_BLOCK_MISMATCH" });
});

test("missing tail rows are rejected even when the remaining prefix is valid", t => {
  const { file, journal } = setup(t, buildDemo().c);
  journal.close();
  alter(file, db => db.exec("DELETE FROM journal_blocks WHERE height > 5"));
  assert.throws(() => new SqliteJournal(file), { code: "JOURNAL_CHAIN_MISMATCH" });
});

test("manifest and derived-state digest corruption fail closed", t => {
  const a = setup(t);
  a.journal.close();
  alter(a.file, db => db.exec("UPDATE journal_meta SET manifest_digest = 'incorrect'"));
  assert.throws(() => new SqliteJournal(a.file), { code: "JOURNAL_MANIFEST_MISMATCH" });
  const b = setup(t);
  b.journal.close();
  alter(b.file, db => db.exec("UPDATE journal_meta SET snapshot_digest = 'incorrect'"));
  assert.throws(() => new SqliteJournal(b.file), { code: "JOURNAL_STATE_MISMATCH" });
});

test("unsupported source, schema additions and version changes are rejected", t => {
  for (const [sql, code] of [
    ["UPDATE journal_meta SET source = 'zcashd-regtest-rpc'", "INVALID_JOURNAL_METADATA"],
    ["CREATE TABLE attributes (power INTEGER)", "INVALID_JOURNAL_SCHEMA"],
    ["PRAGMA user_version = 99", "UNSUPPORTED_JOURNAL_VERSION"],
  ]) {
    const { file, journal } = setup(t);
    journal.close();
    alter(file, db => db.exec(sql));
    assert.throws(() => new SqliteJournal(file), { code });
  }
});

test("capacity is bounded and invalid production manifests never create a file", t => {
  const { file, journal, directory } = setup(t);
  assert.throws(() => journal.append(new Array(10001).fill({})), { code: "JOURNAL_CAPACITY_EXCEEDED" });
  assert.equal(journal.revision, 1);
  const target = path.join(directory, "production.sqlite");
  assert.throws(() => SqliteJournal.create(target, makeManifest({ network: 0 })));
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => SqliteJournal.create(file, makeManifest()), { code: "EEXIST" });
});

test("symlinks, hard links, permissive files and unsafe SQLite sidecars are rejected", t => {
  const { file, journal, directory } = setup(t);
  journal.close();
  const symlink = path.join(directory, "link.sqlite");
  fs.symlinkSync(file, symlink);
  assert.throws(() => new SqliteJournal(symlink), { code: "UNSAFE_JOURNAL_FILE" });
  const hardlink = path.join(directory, "hard.sqlite");
  fs.linkSync(file, hardlink);
  assert.throws(() => new SqliteJournal(file), { code: "UNSAFE_JOURNAL_FILE" });
  fs.unlinkSync(hardlink);
  fs.chmodSync(file, 0o644);
  assert.throws(() => new SqliteJournal(file), { code: "JOURNAL_PRIVATE_PERMISSIONS_REQUIRED" });
  fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, file + "-journal");
  assert.throws(() => new SqliteJournal(file), { code: "UNSAFE_JOURNAL_SIDECAR" });
});

test("same revision/chain cannot silently switch the immutable manifest", t => {
  const { file, journal, context } = setup(t);
  const manifest = { ...context.manifest, max_supply: 332 };
  const digest = value => hash("EBZ_LOCAL_SQLITE_V1", canonical(value)).toString("hex");
  const modified = new Indexer(manifest);
  modified.append(context.blocks);
  alter(file, db => db.prepare("UPDATE journal_meta SET manifest = ?, manifest_digest = ?, snapshot_digest = ?").run(
    canonical(manifest), digest(manifest), digest(modified.snapshot())));
  assert.throws(() => journal.append([block(context.blocks[0])]), { code: "STALE_JOURNAL_WRITER" });
});

test("forced process exit during an uncommitted write recovers the complete previous revision", t => {
  const { file, journal } = setup(t, buildDemo().c);
  const before = canonical(journal.snapshot());
  journal.close();
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size = 1; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; DELETE FROM journal_blocks');
    db.prepare('UPDATE journal_meta SET manifest = ?, revision = 99').run('x'.repeat(200000));
    process.kill(process.pid, 'SIGKILL');
  `;
  const result = spawnSync(process.execPath, ["-e", script, file], { timeout: 10000, encoding: "utf8" });
  assert.equal(result.signal, "SIGKILL");
  const recovered = new SqliteJournal(file);
  try {
    assert.equal(recovered.revision, 1);
    assert.equal(canonical(recovered.snapshot()), before);
  } finally { recovered.close(); }
});

test("cross-process committed writes are detected rather than overwritten", t => {
  const { file, journal, context } = setup(t);
  const script = `
    const { SqliteJournal } = require(process.argv[1]);
    const { block } = require(process.argv[2]);
    const journal = new SqliteJournal(process.argv[3]);
    const chain = journal.replayIndexer().chain;
    journal.append([block(chain.at(-1), [], 'child-writer')]);
    journal.close();
  `;
  const result = spawnSync(process.execPath, ["-e", script, require.resolve("../storage/sqlite-journal"),
    require.resolve("./helpers"), file], { timeout: 10000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => journal.append([block(context.blocks.at(-1))]), { code: "STALE_JOURNAL_WRITER" });
  journal.refresh();
  assert.equal(journal.revision, 2);
  assert.equal(journal.snapshot().observed_height, 1);
});

test("aggregate byte capacity rejects growth without changing the last committed snapshot", t => {
  const { file, journal, context } = setup(t);
  const before = canonical(journal.snapshot());
  // A valid block can include large unrelated records; these must not bypass the disk budget.
  const padding = "x".repeat(120000);
  const transactions = Array.from({ length: 256 }, (_, index) => ({
    txid: hash("SQLITE_CAPACITY_TEST", String(index)).toString("hex"),
    outputs: [], padding,
  }));
  const huge = block(context.blocks.at(-1), transactions);
  journal.append([huge]);
  const committed = canonical(journal.snapshot());
  const secondTransactions = transactions.map((tx, index) => ({ ...tx,
    txid: hash("SQLITE_SECOND_CAPACITY_TEST", String(index)).toString("hex"), padding: "x".repeat(16000) }));
  const second = block(huge, secondTransactions, "second-large");
  assert.throws(() => journal.append([second]), { code: "JOURNAL_CAPACITY_EXCEEDED" });
  assert.notEqual(committed, before);
  assert.equal(canonical(journal.snapshot()), committed);
  const recovered = new SqliteJournal(file, { readOnly: true });
  try { assert.equal(canonical(recovered.snapshot()), committed); }
  finally { recovered.close(); }
});
