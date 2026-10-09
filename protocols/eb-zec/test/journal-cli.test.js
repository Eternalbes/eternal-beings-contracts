const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { buildDemo } = require("../bin/demo");
const { SqliteJournal } = require("../storage/sqlite-journal");
const { renderSvg } = require("../lib/renderer");

function fixture(t) {
  const { c } = buildDemo();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebz-journal-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "chain.sqlite");
  const journal = SqliteJournal.create(file, c.manifest);
  try { journal.append(c.blocks); } finally { journal.close(); }
  return { c, file };
}

test("inspection CLI verifies recovery without printing memos or controller secrets", t => {
  const { c, file } = fixture(t);
  const result = spawnSync(process.execPath, [require.resolve("../bin/journal-inspect"), file], {
    timeout: 10000, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.recovery_verified, true);
  assert.equal(report.root, c.indexer.snapshot().root);
  assert.equal(report.minted, 3);
  assert.equal(report.active, 1);
  assert.equal(report.consumed, 2);
  assert.equal(report.real_zcash_integration, false);
  assert.equal(result.stdout.includes("memo_hex"), false);
  assert.equal(result.stdout.includes(c.entries[0].secret), false);
});

test("journal-backed API CLI reads recovered state, NFT SVG and metadata over localhost", { timeout: 15000 }, async t => {
  const { c, file } = fixture(t);
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [require.resolve("../bin/serve"), "--journal", file], {
    env: { PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  const closed = once(child, "close");
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("API_START_TIMEOUT")), 5000);
      let text = "";
      child.stdout.on("data", chunk => {
        text += chunk.toString();
        if (text.includes(`/v1/network`)) { clearTimeout(timer); resolve(); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("API_EXITED_BEFORE_READY")); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    const url = `http://127.0.0.1:${port}`;
    const get = route => fetch(url + route, { signal: AbortSignal.timeout(2000) });
    const network = await (await get("/v1/network")).json();
    assert.equal(network.live_zcash_scanner, false);
    assert.equal(network.broadcast_supported, false);
    const being = Object.values(c.indexer.state.beings).find(item => item.status === "active") ||
      Object.values(c.indexer.state.beings)[0];
    const state = await (await get(`/v1/beings/${being.being_id}`)).json();
    assert.deepEqual(state.being, being);
    assert.equal(await (await get(`/v1/beings/${being.being_id}/render.svg`)).text(), renderSvg(being));
    const metadata = await (await get(`/v1/beings/${being.being_id}/metadata.json`)).json();
    assert.equal(Buffer.from(metadata.image.split(",")[1], "base64").toString(), renderSvg(being));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
});

test("journal API startup sanitizes malformed stored JSON rather than echoing its contents", t => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  try { db.exec("UPDATE journal_meta SET manifest = 'PRIVATE_DIAGNOSTIC_MUST_NOT_LEAK'"); }
  finally { db.close(); }
  const result = spawnSync(process.execPath, [require.resolve("../bin/serve"), "--journal", file], {
    env: { PORT: "8787" }, timeout: 10000, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /(^|\n)JOURNAL_API_FAILED(\n|$)/);
  assert.equal(result.stderr.includes("PRIVATE_DIAGNOSTIC_MUST_NOT_LEAK"), false);
});
