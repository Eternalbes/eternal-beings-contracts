# Local SQLite Journal and Recovery

This storage layer belongs to the **local EB-ZEC V0.1 reference**, not a live Zcash world. It changes neither the signed state rules nor the renderer nor the checked-in golden fixture. Real-node observations still cannot be activated as V0.1 input. No transaction broadcaster, spending key, new token, bridge, or marketplace is included.

## Run

Use Node.js 22.13.0 or newer with the built-in `node:sqlite` module. The implementation uses its synchronous database API with bound statement parameters and disabled extensions; see the [official Node.js documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html). There is no new npm dependency. This change was tested on Node.js 26.0.0; other runtime versions need their own release checks.

From `protocols/eb-zec`:

```sh
npm test
npm run journal:demo
npm run journal:inspect -- local/journal-demo.sqlite
npm run serve:journal -- local/journal-demo.sqlite
```

`journal:demo` exclusively creates `local/journal-demo.sqlite`, persists the public deterministic fixture, closes the database, reopens it read-only, and compares recovered state with the original. It covers three Mints, a Hunt, a fusion, a devour and a rejected forged nonce. Repeated execution refuses to overwrite the existing file. For a separate run, pass another basename, for example `npm run journal:demo -- recovery-2.sqlite`.

`journal:inspect` verifies and replays an existing private-permission database without accepting mutations or printing raw memos. `serve:journal` exposes the existing localhost-only API from a fully replayed copy at startup. It **does not** watch the database or import new blocks. Restart that API after a writer commits new blocks. The original `npm run serve` fixture mode is unchanged. Use `PORT=8788` if the default port is occupied, and stop with Ctrl+C.

The database and its SQLite sidecars are excluded from Git. The demo writes no wallet key, password or client unrevealed-secret file. Fixture reveal secrets and public deterministic test controllers are intentionally public and unsafe for real funds.

## Data Model

One database holds one immutable local manifest. Schema version 1 has exactly two strict tables:

- `journal_meta`: source label, canonical manifest and digest, revision, canonical chain digest and derived snapshot digest.
- `journal_blocks`: height, canonical block JSON and domain-separated BLAKE2b-256 digest.

There is **no editable attribute snapshot table**. Opening or explicitly refreshing a journal checks its schema, SQLite integrity, bounds and digests, then reconstructs the existing Indexer from genesis. The resulting snapshot must match its stored digest. This checks all Being attributes, supplies, pending beacons, resources, history, rejection records and checkpoints, not just image metadata. A malformed or inconsistent database fails closed; no automatic migration or silent record deletion occurs.

## Writer API

```js
const { SqliteJournal } = require("./storage/sqlite-journal");

// manifest must be an already-reviewed local V0.1 manifest.
const journal = SqliteJournal.create("/private/project/new-world.sqlite", manifest);
try {
  journal.append(validatedLocalBlocks);
  const snapshot = journal.snapshot();
  // A fork is an explicit replacement of the suffix after a common ancestor.
  journal.replaceFrom(commonAncestorHeight + 1, replacementLocalBlocks);
} finally {
  journal.close();
}
```

The parent directory must exist. Creation is exclusive and uses mode `0600`; existing databases are not overwritten. Opening rejects symbolic links, multiply linked files, group/world-readable files and unsafe existing sidecars. Keep the directory owner-controlled: these checks do not defend against a privileged process or an attacker concurrently replacing the directory/files. Do not rename or replace a database while it has open handles.

`append` and `replaceFrom` acquire a SQLite immediate write transaction, recover/validate the disk journal again, compare the caller's remembered revision, chain digest and manifest, and replay the candidate chain before committing any rows. A failed append or fork replacement rolls back. In-memory state is adopted only after commit. A stale writer receives `STALE_JOURNAL_WRITER`; call `refresh()` and deliberately reconstruct its intended next operation, rather than blindly retrying an obsolete fork.

`snapshot()` and `revision` describe that handle's last successfully loaded revision. They do not poll other writers. `refresh()` acquires a consistent read transaction and replaces the cached state only after successful validation. `replayIndexer()` returns an independent replayed Indexer, never a writable reference to journal internals. An independently replayed API object is not an independently implemented consensus engine.

## Durability and Bounds

Writes use SQLite's rollback journal (`DELETE`) and `synchronous=FULL`. Each suffix update and its metadata revision commit together. An interrupted uncommitted write is recovered by SQLite when reopened with a writable connection. A read-only open may be unable to recover a hot rollback journal; first open with the trusted writer to perform recovery. Never delete a rollback journal to make an error disappear.

Limits are intentionally bounded: 10,000 blocks, 256 transactions per block, 8 outputs per transaction, 32 MiB of canonical chain JSON and 64 MiB for the database file. Each writer sets SQLite's page limit accordingly. SQLite rollback sidecars and backups need additional disk space. Validation/replay is synchronous and full-history: this is not a high-throughput or unlimited-growth database.

Do not copy a database during writes. Close writers cleanly before copying it, keep the original in an owner-controlled directory, and verify recovery on the copy. Maintain a separate pinned manifest and an authenticated canonical chain source. Checksums detect inconsistency; they are **not authentication against an administrator who can rewrite the entire database and recompute every digest**. FULL synchronization is not a guarantee against disk firmware, filesystem or hardware failures.

## Verification and Remaining Work

Automated coverage includes identical restart recovery, confirmed/unconfirmed prefixes, fusion/reward rollback, failed updates, independent concurrent handles, cross-process stale writers, forced process termination during an uncommitted database write, corrupted records/digests, schema/source/version rejection, path permissions and bounded growth. Existing conformance tests still check the untouched golden fixture.

This is a bounded durable prototype. Production work still requires real Zebra/Zallet memo scanning, pinned live manifests, chain authenticity/completeness checks, incremental replay, retention policy, crash/disk-full stress testing on the deployment filesystem, operational monitoring and independent implementations. No real Zcash transaction has been sent by this storage demo.
