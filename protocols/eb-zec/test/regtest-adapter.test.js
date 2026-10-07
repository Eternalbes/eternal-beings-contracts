const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ReadonlyRpc } = require("../adapters/readonly-rpc");
const { scanRegtest } = require("../adapters/zcashd-regtest");
const { loadFixture } = require("../lib/fixture");
const { minted } = require("./helpers");
const { canonical } = require("../lib/crypto");

const run = promisify(execFile);
const hex = (n) => n.toString(16).padStart(64, "0");
const mailbox = "uregtest1mockonlynotarealaddress";

function mockNode() {
  const context = minted(1), messages = context.blocks.flatMap((block) => block.transactions);
  const note = { pool: "orchard", txid: hex(101), amount: 0.00001, amountZat: 1000,
    memo: messages[0].outputs[0].memo_hex, confirmations: 3, blockheight: 1, blockindex: 1, outindex: 0,
    change: false, spendable: false };
  const state = { tip: { chain: "regtest", blocks: 3, bestblockhash: hex(4) },
    blocks: Array.from({ length: 4 }, (_, height) => ({ height, hash: hex(height + 1),
      previousblockhash: height ? hex(height) : undefined, confirmations: 4 - height,
      tx: height === 1 ? [hex(100), hex(101), hex(102)] : [hex(200 + height)] })),
    notes: [note], raw: { txid: hex(101), blockhash: hex(2), in_active_chain: true, orchard: { actions: [{}] } },
    calls: [], hook: null };
  const rpc = { async call(method, params = []) {
    state.calls.push({ method, params });
    if (state.hook) {
      const result = state.hook(method, params);
      if (result !== undefined) return structuredClone(result);
    }
    let result;
    if (method === "getblockchaininfo") result = state.tip;
    else if (method === "getblockhash") result = state.blocks[params[0]]?.hash;
    else if (method === "getblock") result = state.blocks.find((block) => block.hash === params[0]);
    else if (method === "z_listunifiedreceivers") result = { orchard: mailbox };
    else if (method === "z_listreceivedbyaddress") result = state.notes;
    else if (method === "getrawtransaction") result = state.raw;
    else throw new Error("Unexpected RPC method");
    return structuredClone(result);
  } };
  return { state, rpc, options: { mailbox, genesisHash: hex(1), fromHeight: 0, confirmationDepth: 2 } };
}

async function listen(handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks)), request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}/`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test("RPC transport is localhost-only and rejects send, sign, export and import methods before contacting a node", async () => {
  for (const url of ["https://node.example/", "http://localhost:18232/", "http://127.0.0.1/a", "http://user:password@127.0.0.1/",
    "http://127.0.0.1/?token=x", "http://127.0.0.1/#x", "file:///tmp/node"]) {
    assert.throws(() => new ReadonlyRpc({ url }), { code: "LOCAL_RPC_ONLY" });
  }
  assert.throws(() => new ReadonlyRpc({ url: "not a URL" }), { code: "INVALID_RPC_URL" });
  assert.throws(() => new ReadonlyRpc({ url: "http://127.0.0.1/", username: "user" }), { code: "INVALID_RPC_AUTH" });
  const rpc = new ReadonlyRpc({ url: "http://127.0.0.1:1/" });
  for (const method of ["z_sendmany", "sendrawtransaction", "generate", "z_exportkey", "z_importkey", "signrawtransaction",
    "z_getnewaccount", "stop", "constructor", "toString"]) {
    await assert.rejects(rpc.call(method), { code: "RPC_METHOD_FORBIDDEN" });
  }
  await assert.rejects(rpc.call("z_listreceivedbyaddress", [mailbox, 0]), { code: "INVALID_RPC_PARAMS" });
  await assert.rejects(rpc.call("getrawtransaction", [hex(1), 1]), { code: "INVALID_RPC_PARAMS" });
});

test("RPC authenticates locally with private fields, validates IDs and sanitizes remote errors", async () => {
  let mode = "ok", requests = 0;
  const node = await listen((body, request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("test-user:PUBLIC_TEST_PASSWORD").toString("base64")}`);
    assert.equal(body.jsonrpc, "1.0");
    response.end(JSON.stringify({ id: mode === "wrong-id" ? -1 : body.id,
      result: mode === "ok" ? { chain: "regtest" } : null,
      error: mode === "error" ? { code: -8, message: "PRIVATE_DETAIL_DO_NOT_PRINT" } : null }));
  });
  try {
    const rpc = new ReadonlyRpc({ url: node.url, username: "test-user", password: "PUBLIC_TEST_PASSWORD" });
    assert.equal(JSON.stringify(rpc), "{}");
    assert.deepEqual(await rpc.call("getblockchaininfo"), { chain: "regtest" });
    mode = "wrong-id";
    await assert.rejects(rpc.call("getblockchaininfo"), { code: "INVALID_RPC_RESPONSE" });
    mode = "error";
    await assert.rejects(rpc.call("getblockchaininfo"), (error) => {
      assert.equal(error.rpcCode, -8); assert.equal(error.message, "RPC_REMOTE_ERROR");
      assert.ok(!error.stack.includes("PRIVATE_DETAIL")); return true;
    });
    await assert.rejects(rpc.call("getblockhash", [-1]), { code: "INVALID_RPC_PARAMS" });
    assert.equal(requests, 3);
  } finally { await node.close(); }
});

test("RPC fails closed on redirects, malformed UTF-8/JSON, oversized responses and timeouts", async () => {
  let mode = "redirect", redirects = 0;
  const node = await listen((body, request, response) => {
    if (mode === "redirect") { response.writeHead(302, { Location: "/" }); response.end(); redirects++; }
    else if (mode === "utf8") response.end(Buffer.from([0xff]));
    else if (mode === "json") response.end("not json");
    else if (mode === "large") response.end("x".repeat(2048));
    // timeout mode intentionally leaves the request unanswered.
  });
  try {
    const rpc = new ReadonlyRpc({ url: node.url, timeoutMs: 100, maxResponseBytes: 1024 });
    await assert.rejects(rpc.call("getblockchaininfo"), { code: "RPC_HTTP_ERROR" });
    assert.equal(redirects, 1);
    for (mode of ["utf8", "json"]) await assert.rejects(rpc.call("getblockchaininfo"), { code: "INVALID_RPC_RESPONSE" });
    mode = "large";
    await assert.rejects(rpc.call("getblockchaininfo"), { code: "RPC_RESPONSE_TOO_LARGE" });
    mode = "timeout";
    await assert.rejects(rpc.call("getblockchaininfo"), { code: "RPC_TIMEOUT" });
  } finally { await node.close(); }
});

test("regtest scan preserves real block/transaction positions and spent-note history; it never applies protocol state", async () => {
  const { state, rpc, options } = mockNode();
  const observation = await scanRegtest(rpc, options);
  assert.equal(observation.source_kind, "zcashd-regtest-rpc");
  assert.equal(observation.protocol_state_applied, false);
  assert.equal(observation.independently_decrypted, false);
  assert.equal(observation.broadcast_supported, false);
  assert.deepEqual(observation.range, { from_height: 0, to_height: 2 });
  assert.equal(observation.next_height, 3);
  assert.equal(observation.blocks[1].transaction_ids.length, 3);
  assert.equal(observation.candidates[0].transaction_index, 1);
  assert.equal(observation.candidates[0].value_zat, 1000);
  assert.equal(observation.candidates[0].envelope_valid, true);
  assert.equal(observation.candidates[0].state_authorized, false);
  assert.equal(observation.candidates[0].op, "world-genesis");
  assert.deepEqual(state.calls.find((call) => call.method === "z_listreceivedbyaddress").params, [mailbox, 1, 2]);
  assert.deepEqual(state.calls.find((call) => call.method === "getrawtransaction").params, [hex(101), 1, hex(2)]);
  assert.ok(!state.calls.some((call) => call.method === "z_listunspent"));
  assert.equal(canonical(observation), canonical(await scanRegtest(rpc, options)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebz-observation-")), file = path.join(directory, "scan.json");
  try {
    fs.writeFileSync(file, canonical(observation));
    assert.throws(() => loadFixture(file), { code: "UNTRUSTED_SOURCE_FORMAT" });
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("regtest scan rejects mainnet/testnet, wrong genesis, non-Orchard addresses and invalid ranges", async () => {
  for (const chain of ["main", "test", "unknown"]) {
    const c = mockNode(); c.state.tip.chain = chain;
    await assert.rejects(scanRegtest(c.rpc, c.options), { code: "REGTEST_RPC_ONLY" });
    assert.equal(c.state.calls.length, 1);
  }
  let c = mockNode();
  await assert.rejects(scanRegtest(c.rpc, { ...c.options, genesisHash: hex(999) }), { code: "NODE_GENESIS_MISMATCH" });
  c = mockNode(); c.state.hook = (method) => method === "z_listunifiedreceivers" ? { sapling: "zregtest" } : undefined;
  await assert.rejects(scanRegtest(c.rpc, c.options), { code: "ORCHARD_MAILBOX_REQUIRED" });
  for (const overrides of [{ fromHeight: -1 }, { maxBlocks: 201 }, { confirmationDepth: 0 }]) {
    c = mockNode(); await assert.rejects(scanRegtest(c.rpc, { ...c.options, ...overrides }), { code: "INVALID_SCAN_RANGE" });
    assert.equal(c.state.calls.length, 0);
  }
});

test("regtest scan rejects forged block order, missing transactions, fractional ZEC fallbacks and invalid action indexes", async () => {
  const cases = [
    [(c) => { c.state.blocks[1].previousblockhash = hex(99); }, "NODE_BLOCK_MISMATCH"],
    [(c) => { c.state.blocks[1].tx.push(hex(101)); }, "DUPLICATE_NODE_TRANSACTION"],
    [(c) => { c.state.notes[0].blockindex = 0; }, "NOTE_TRANSACTION_MISMATCH"],
    [(c) => { c.state.notes[0].txid = hex(999); }, "NOTE_TRANSACTION_MISMATCH"],
    [(c) => { delete c.state.notes[0].amountZat; }, "INTEGER_ZAT_REQUIRED"],
    [(c) => { c.state.notes[0].amountZat = 0.1; }, "INTEGER_ZAT_REQUIRED"],
    [(c) => { c.state.notes[0].amountZat = 2100000000000001; }, "INTEGER_ZAT_REQUIRED"],
    [(c) => { c.state.notes[0].outindex = 1; }, "INVALID_ORCHARD_ACTION_INDEX"],
    [(c) => { c.state.raw.in_active_chain = false; }, "NODE_TRANSACTION_MISMATCH"],
    [(c) => { c.state.raw.blockhash = hex(999); }, "NODE_TRANSACTION_MISMATCH"],
    [(c) => { c.state.notes[0].confirmations = 0; }, "UNCONFIRMED_OR_INVALID_NOTE"],
    [(c) => { c.state.notes[0].blockheight = 3; }, "NOTE_AFTER_SNAPSHOT"],
    [(c) => { c.state.notes[0].pool = "sapling"; }, "UNSUPPORTED_CARRIER_POOL"],
    [(c) => { c.state.notes[0].memo = "ff"; }, "INVALID_NOTE_MEMO"],
    [(c) => { c.state.notes.push(structuredClone(c.state.notes[0])); }, "DUPLICATE_NODE_NOTE"],
  ];
  for (const [edit, code] of cases) {
    const c = mockNode(); edit(c);
    await assert.rejects(scanRegtest(c.rpc, c.options), { code });
  }
});

test("scan retains invalid protocol envelopes for diagnosis without leaking unrelated memos", async () => {
  const c = mockNode();
  c.state.notes.push({ ...c.state.notes[0], outindex: 1, memo: "ff" + "00".repeat(511) },
    { ...c.state.notes[0], outindex: 2, memo: "f6" + "00".repeat(511) });
  c.state.raw.orchard.actions = [{}, {}, {}];
  const observation = await scanRegtest(c.rpc, c.options);
  assert.equal(observation.candidates.length, 2);
  assert.equal(observation.candidates[1].envelope_valid, false);
  assert.ok(observation.candidates[1].error_code);
  assert.equal(observation.ignored.non_protocol, 1);
  assert.equal(c.state.calls.filter((call) => call.method === "getrawtransaction").length, 1);
});

test("scan rejects mid-read reorgs atomically and accepts tip extension only when its anchor remains canonical", async () => {
  for (const kind of ["tip", "range", "genesis", "network"]) {
    const c = mockNode(); let tipReads = 0;
    c.state.hook = (method, params) => {
      if (method === "getblockchaininfo" && ++tipReads > 1 && kind === "network") return { ...c.state.tip, chain: "main" };
      if (tipReads > 1 && method === "getblockhash") {
        if ((kind === "tip" && params[0] === 3) || (kind === "range" && params[0] === 2) ||
          (kind === "genesis" && params[0] === 0)) return hex(999);
      }
    };
    await assert.rejects(scanRegtest(c.rpc, c.options), { code: kind === "network" ? "REGTEST_RPC_ONLY" : "SCAN_REORG_DETECTED" });
  }
  const c = mockNode(); let reads = 0;
  c.state.blocks.push({ height: 4, hash: hex(5) });
  c.state.hook = (method) => method === "getblockchaininfo" && ++reads > 1 ?
    { ...c.state.tip, blocks: 4, bestblockhash: hex(5) } : undefined;
  assert.equal((await scanRegtest(c.rpc, c.options)).anchor_tip.height, 3);
});

test("scan refuses malformed tips, orphan blocks, duplicate hashes and resource-exhausting block contexts", async () => {
  const cases = [
    [(c) => { c.state.tip.blocks = 0.5; }, "INVALID_NODE_TIP"],
    [(c) => { c.state.tip.bestblockhash = [hex(4)]; }, "INVALID_NODE_TIP"],
    [(c) => { c.state.blocks[1].confirmations = -1; }, "NODE_BLOCK_MISMATCH"],
    [(c) => { c.state.blocks[1].tx = Array(12001).fill(hex(101)); }, "INVALID_NODE_TRANSACTIONS"],
    [(c) => { c.state.blocks[1].tx = [{ txid: hex(101) }]; }, "INVALID_NODE_TRANSACTIONS"],
    [(c) => { c.state.blocks[1].hash = hex(1); }, "DUPLICATE_NODE_BLOCK"],
  ];
  for (const [edit, code] of cases) {
    const c = mockNode(); edit(c);
    await assert.rejects(scanRegtest(c.rpc, c.options), { code });
  }
});

test("scan refuses candidate overflow without truncating or merging protocol operations", async () => {
  const c = mockNode();
  c.state.notes = Array.from({ length: 1025 }, (_, outindex) => ({ ...c.state.notes[0], outindex }));
  c.state.raw.orchard.actions = Array(1025).fill({});
  await assert.rejects(scanRegtest(c.rpc, c.options), { code: "SCAN_CANDIDATE_LIMIT" });
});

test("scan bounds each batch, skips earlier history and waits instead of reading unconfirmed notes", async () => {
  let c = mockNode();
  c.state.notes.push({ ...c.state.notes[0], blockheight: 0 });
  const partial = await scanRegtest(c.rpc, { ...c.options, fromHeight: 1, maxBlocks: 1 });
  assert.deepEqual(partial.range, { from_height: 1, to_height: 1 });
  assert.equal(partial.blocks[0].parent_hash, hex(1));
  assert.equal(partial.ignored.outside_range, 1);
  c = mockNode();
  const waiting = await scanRegtest(c.rpc, { ...c.options, fromHeight: 3 });
  assert.equal(waiting.range, null); assert.equal(waiting.next_height, 3);
  assert.ok(!c.state.calls.some((call) => call.method === "z_listreceivedbyaddress"));
  c = mockNode(); c.state.notes = Array(20001).fill(c.state.notes[0]);
  await assert.rejects(scanRegtest(c.rpc, c.options), { code: "SCAN_NOTE_LIMIT" });
});

test("regtest scan CLI works end-to-end over HTTP, excludes credentials and refuses overwrite or path escapes", async () => {
  const c = mockNode();
  const node = await listen(async (body, request, response) => {
    const result = await c.rpc.call(body.method, body.params);
    response.end(JSON.stringify({ id: body.id, result, error: null }));
  });
  const packageRoot = path.resolve(__dirname, ".."), filename = `test-regtest-${process.pid}.json`;
  const file = path.join(packageRoot, "output", filename);
  const env = { ...process.env, EBZ_RPC_URL: node.url, EBZ_RPC_USER: "test-user", EBZ_RPC_PASSWORD: "PUBLIC_TEST_PASSWORD",
    EBZ_REGTEST_MAILBOX: mailbox, EBZ_REGTEST_GENESIS_HASH: hex(1), EBZ_REGTEST_FROM_HEIGHT: "0" };
  try {
    const result = await run(process.execPath, ["bin/scan-regtest.js", filename], { cwd: packageRoot, env });
    assert.equal(JSON.parse(result.stdout).protocol_state_applied, false);
    const written = fs.readFileSync(file, "utf8");
    assert.ok(!written.includes("PUBLIC_TEST_PASSWORD")); assert.ok(!written.includes("test-user"));
    assert.ok(!written.includes(node.url));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await assert.rejects(run(process.execPath, ["bin/scan-regtest.js", filename], { cwd: packageRoot, env }),
      (error) => { assert.match(error.stderr, /OUTPUT_ALREADY_EXISTS/); return true; });
    await assert.rejects(run(process.execPath, ["bin/scan-regtest.js", "../leak.json"], { cwd: packageRoot, env }),
      (error) => { assert.match(error.stderr, /OUTPUT_FILENAME_ONLY/); return true; });
    assert.equal(written, fs.readFileSync(file, "utf8"));
  } finally { fs.rmSync(file, { force: true }); await node.close(); }
});
