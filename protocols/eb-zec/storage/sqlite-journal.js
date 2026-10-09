const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Indexer } = require("../lib/indexer");
const { canonical, hash, ensure } = require("../lib/crypto");

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TABLES = {
  journal_meta: "CREATE TABLE journal_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, source TEXT NOT NULL, manifest TEXT NOT NULL, manifest_digest TEXT NOT NULL, revision INTEGER NOT NULL, chain_digest TEXT NOT NULL, snapshot_digest TEXT NOT NULL) STRICT",
  journal_blocks: "CREATE TABLE journal_blocks (height INTEGER PRIMARY KEY, block_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT",
};
const digest = (value) => hash("EBZ_LOCAL_SQLITE_V1", canonical(value)).toString("hex");

function limitDatabase(db) {
  const pages = Math.floor(MAX_FILE_BYTES / db.prepare("PRAGMA page_size").get().page_size);
  ensure(db.prepare(`PRAGMA max_page_count = ${pages}`).get().max_page_count <= pages, "JOURNAL_FILE_TOO_LARGE");
}

function checkedFile(file, create = false) {
  ensure(typeof file === "string" && file.length > 0 && file !== ":memory:", "JOURNAL_FILE_REQUIRED");
  const resolved = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(resolved));
  const target = path.join(parent, path.basename(resolved));
  if (create) {
    const fd = fs.openSync(target, "wx", 0o600);
    fs.closeSync(fd);
  }
  const stat = fs.lstatSync(target);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "UNSAFE_JOURNAL_FILE");
  ensure(stat.size <= MAX_FILE_BYTES, "JOURNAL_FILE_TOO_LARGE");
  ensure((stat.mode & 0o077) === 0, "JOURNAL_PRIVATE_PERMISSIONS_REQUIRED");
  // Rollback journals must not redirect SQLite writes into another file.
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const sidecar = fs.lstatSync(target + suffix);
      ensure(sidecar.isFile() && !sidecar.isSymbolicLink() && sidecar.nlink === 1 &&
        (sidecar.mode & 0o077) === 0, "UNSAFE_JOURNAL_SIDECAR");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

class SqliteJournal {
  #db;
  #indexer;
  #revision;
  #chainDigest;
  #readOnly;

  static create(file, manifest) {
    const indexer = new Indexer(manifest);
    ensure(Buffer.byteLength(canonical(indexer.manifest)) <= 4096, "JOURNAL_MANIFEST_TOO_LARGE");
    const target = checkedFile(file, true);
    const db = new DatabaseSync(target, { allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
      limitDatabase(db);
      db.exec("BEGIN IMMEDIATE");
      for (const sql of Object.values(TABLES)) db.exec(sql);
      db.prepare("INSERT INTO journal_meta VALUES (1, 1, ?, ?, ?, 0, ?, ?)").run(
        "local-fixture", canonical(indexer.manifest), digest(indexer.manifest), digest([]), digest(indexer.snapshot()));
      db.exec("PRAGMA user_version = 1; COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally { db.close(); }
    return new SqliteJournal(target);
  }

  constructor(file, { readOnly = false } = {}) {
    ensure(typeof readOnly === "boolean", "INVALID_JOURNAL_OPTIONS");
    this.#readOnly = readOnly;
    this.#db = new DatabaseSync(checkedFile(file), { readOnly, allowExtension: false });
    try {
      this.#db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000");
      if (!readOnly) {
        ensure(this.#db.prepare("PRAGMA journal_mode").get().journal_mode === "delete", "UNSUPPORTED_JOURNAL_MODE");
        this.#db.exec("PRAGMA synchronous = FULL");
        limitDatabase(this.#db);
      }
      this.refresh();
    } catch (error) { this.#db.close(); this.#db = null; throw error; }
  }

  #transaction(write, work) {
    ensure(this.#db, "JOURNAL_CLOSED");
    ensure(!write || !this.#readOnly, "JOURNAL_READ_ONLY");
    this.#db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #recover() {
    ensure(this.#db.prepare("PRAGMA user_version").get().user_version === 1, "UNSUPPORTED_JOURNAL_VERSION");
    const schema = this.#db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    ensure(schema.length === 2 && schema.every(row => row.type === "table" && TABLES[row.name] === row.sql), "INVALID_JOURNAL_SCHEMA");
    ensure(this.#db.prepare("PRAGMA quick_check").get().quick_check === "ok", "JOURNAL_INTEGRITY_FAILED");
    const bounds = this.#db.prepare("SELECT count(*) AS n, max(length(CAST(manifest AS BLOB))) AS bytes FROM journal_meta").get();
    ensure(bounds.n === 1 && bounds.bytes <= 4096, "INVALID_JOURNAL_METADATA");
    const meta = this.#db.prepare("SELECT * FROM journal_meta WHERE id = 1").get();
    ensure(meta && meta.version === 1 && meta.source === "local-fixture" &&
      Number.isSafeInteger(meta.revision) && meta.revision >= 0, "INVALID_JOURNAL_METADATA");
    const manifest = JSON.parse(meta.manifest);
    ensure(canonical(manifest) === meta.manifest && digest(manifest) === meta.manifest_digest, "JOURNAL_MANIFEST_MISMATCH");
    const size = this.#db.prepare("SELECT count(*) AS n, coalesce(sum(length(CAST(block_json AS BLOB))), 0) AS bytes FROM journal_blocks").get();
    ensure(size.n <= 10000 && size.bytes <= MAX_BYTES, "JOURNAL_CAPACITY_EXCEEDED");
    const chain = this.#db.prepare("SELECT * FROM journal_blocks ORDER BY height").all().map(row => {
      const block = JSON.parse(row.block_json);
      ensure(canonical(block) === row.block_json && block.height === row.height && digest(block) === row.digest, "JOURNAL_BLOCK_MISMATCH");
      return block;
    });
    ensure(digest(chain) === meta.chain_digest, "JOURNAL_CHAIN_MISMATCH");
    const indexer = new Indexer(manifest);
    indexer.append(chain);
    ensure(digest(indexer.snapshot()) === meta.snapshot_digest, "JOURNAL_STATE_MISMATCH");
    return { indexer, revision: meta.revision, chainDigest: meta.chain_digest };
  }

  #adopt({ indexer, revision, chainDigest }) {
    this.#indexer = indexer;
    this.#revision = revision;
    this.#chainDigest = chainDigest;
    return this.snapshot();
  }

  refresh() { return this.#adopt(this.#transaction(false, () => this.#recover())); }
  snapshot() {
    ensure(this.#db, "JOURNAL_CLOSED");
    return this.#indexer.snapshot();
  }
  replayIndexer() {
    ensure(this.#db, "JOURNAL_CLOSED");
    const indexer = new Indexer(this.#indexer.manifest);
    indexer.append(this.#indexer.chain);
    return indexer;
  }
  get revision() { ensure(this.#db, "JOURNAL_CLOSED"); return this.#revision; }
  append(blocks) {
    ensure(this.#db, "JOURNAL_CLOSED");
    return this.replaceFrom(this.#indexer.manifest.genesis_height + this.#indexer.chain.length, blocks);
  }
  replaceFrom(height, blocks) {
    const next = this.#transaction(true, () => {
      const current = this.#recover();
      ensure(current.revision === this.#revision && current.chainDigest === this.#chainDigest &&
        canonical(current.indexer.manifest) === canonical(this.#indexer.manifest), "STALE_JOURNAL_WRITER");
      ensure(this.#revision < Number.MAX_SAFE_INTEGER, "JOURNAL_REVISION_OVERFLOW");
      ensure(Array.isArray(blocks) && blocks.length <= 10000, "JOURNAL_CAPACITY_EXCEEDED");
      ensure(Buffer.byteLength(canonical(blocks)) <= MAX_BYTES, "JOURNAL_CAPACITY_EXCEEDED");
      current.indexer.replaceFrom(height, blocks);
      const chain = current.indexer.chain;
      ensure(Buffer.byteLength(canonical(chain)) <= MAX_BYTES, "JOURNAL_CAPACITY_EXCEEDED");
      const chainDigest = digest(chain);
      this.#db.prepare("DELETE FROM journal_blocks WHERE height >= ?").run(height);
      const insert = this.#db.prepare("INSERT INTO journal_blocks VALUES (?, ?, ?)");
      for (const block of chain.slice(height - current.indexer.manifest.genesis_height)) {
        insert.run(block.height, canonical(block), digest(block));
      }
      this.#db.prepare("UPDATE journal_meta SET revision = ?, chain_digest = ?, snapshot_digest = ? WHERE id = 1").run(
        current.revision + 1, chainDigest, digest(current.indexer.snapshot()));
      return { indexer: current.indexer, revision: current.revision + 1, chainDigest };
    });
    return this.#adopt(next);
  }
  close() {
    if (this.#db) { this.#db.close(); this.#db = null; }
  }
}

module.exports = { SqliteJournal };
