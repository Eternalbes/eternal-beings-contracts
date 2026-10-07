const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { ReadonlyRpc } = require("../adapters/readonly-rpc");
const { REQUIRED_METHODS, inspectDiscovery, probeRegtest } = require("../adapters/regtest-preflight");
const { doctor, composeCompatible } = require("../bin/doctor-regtest");

const hex = (n) => n.toString(16).padStart(64, "0");
const schema = () => ({ openrpc: "1.2.6", methods: REQUIRED_METHODS.map((name) => ({ name })) });

async function serve(handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    response.end(JSON.stringify(handler(body)));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { calls, url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

function fakeRpc() {
  const calls = [], tip = { chain: "regtest", blocks: 2, bestblockhash: hex(3) };
  const discovery = schema();
  return { calls, tip, discovery,
    async call(method, params = []) {
      calls.push({ method, params });
      if (method === "getblockchaininfo") return structuredClone(tip);
      if (method === "getblockhash") return hex(params[0] + 1);
      if (method === "rpc.discover") return structuredClone(discovery);
      throw new Error("Unexpected RPC method");
    } };
}

test("JSON-RPC 2.0 accepts result-only and error-only responses, without changing legacy mode", async () => {
  let mode = "success";
  const node = await serve((body) => {
    assert.equal(body.jsonrpc, "2.0");
    return mode === "success" ? { jsonrpc: "2.0", id: body.id, result: null } :
      { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "SENSITIVE_REMOTE_TEXT" } };
  });
  try {
    const rpc = new ReadonlyRpc({ url: node.url, jsonrpcVersion: "2.0" });
    assert.equal(await rpc.call("rpc.discover"), null);
    mode = "error";
    await assert.rejects(rpc.call("rpc.discover"), (error) => {
      assert.equal(error.code, "RPC_REMOTE_ERROR"); assert.equal(error.rpcCode, -32601);
      assert.ok(!error.stack.includes("SENSITIVE_REMOTE_TEXT")); return true;
    });
    assert.equal(JSON.stringify(rpc), "{}");
    assert.throws(() => new ReadonlyRpc({ url: node.url, jsonrpcVersion: "3.0" }), { code: "INVALID_RPC_VERSION" });
  } finally { await node.close(); }
});

test("JSON-RPC 2.0 refuses response ambiguity, null errors, wrong versions and mixed-mode downgrade", async () => {
  let result;
  const node = await serve((body) => ({ ...result, id: body.id }));
  try {
    const rpc = new ReadonlyRpc({ url: node.url, jsonrpcVersion: "2.0" });
    for (result of [
      { jsonrpc: "2.0", result: {}, error: null },
      { jsonrpc: "2.0", error: null },
      { jsonrpc: "2.0", error: { code: "bad", message: "bad" } },
      { jsonrpc: "2.0", error: { code: -1 } },
      { result: {} }, { jsonrpc: "1.0", result: {} }, { jsonrpc: "2.0" },
    ]) await assert.rejects(rpc.call("getblockchaininfo"), { code: "INVALID_RPC_RESPONSE" });
  } finally { await node.close(); }
});

test("OpenRPC discovery reports missing/ambiguous requirements but never enables advertised signing methods or URLs", async () => {
  const discovery = schema();
  discovery.methods.push({ name: "z_exportkey" }, { name: "sendrawtransaction" });
  discovery.servers = [{ url: "https://untrusted.example/" }];
  let inspected = inspectDiscovery(discovery);
  assert.deepEqual(inspected.missing_methods, []);
  assert.equal(inspected.capabilities_executed, false);
  const rpc = new ReadonlyRpc({ url: "http://127.0.0.1:1/", jsonrpcVersion: "2.0" });
  await assert.rejects(rpc.call("z_exportkey"), { code: "RPC_METHOD_FORBIDDEN" });
  discovery.methods.shift(); discovery.methods.push({ name: "getblock" });
  inspected = inspectDiscovery(discovery);
  assert.deepEqual(inspected.missing_methods, ["getblockchaininfo"]);
  assert.deepEqual(inspected.ambiguous_methods, ["getblock"]);
  for (const malformed of [null, {}, { openrpc: "2.0.0", methods: [] },
    { openrpc: "1.2.6", methods: [{ name: "<script>" }] }, { openrpc: "1.2.6", methods: Array(1025).fill({ name: "getblock" }) }]) {
    assert.throws(() => inspectDiscovery(malformed), { code: "INVALID_RPC_DISCOVERY" });
  }
});

test("regtest preflight checks the pinned anchor and declaration inventory, not Mint, wallet ownership or readiness", async () => {
  const rpc = fakeRpc();
  const probe = await probeRegtest(rpc, { genesisHash: hex(1) });
  assert.equal(probe.genesis_pin_matches, true); assert.equal(probe.chain_anchor_consistent, true);
  assert.equal(probe.initial_sync_complete, null); assert.equal(probe.sync_validation_complete, false);
  assert.equal(probe.mailbox_checked, false); assert.equal(probe.protocol_state_applied, false);
  assert.equal(probe.real_memo_integration_test_complete, false);
  assert.ok(rpc.calls.every((call) => ["getblockchaininfo", "getblockhash", "rpc.discover"].includes(call.method)));
});

test("regtest preflight never treats testnet or a matching guessed pin as authorization", async () => {
  for (const chain of ["main", "test", "Regtest"]) {
    const rpc = fakeRpc(); rpc.tip.chain = chain;
    await assert.rejects(probeRegtest(rpc, { genesisHash: hex(1) }), { code: "REGTEST_RPC_ONLY" });
    assert.equal(rpc.calls.length, 1);
  }
  const rpc = fakeRpc();
  await assert.rejects(probeRegtest(rpc, { genesisHash: hex(999) }), { code: "NODE_GENESIS_MISMATCH" });
  assert.ok(!rpc.calls.some((call) => call.method === "rpc.discover"));
});

test("preflight rejects a changing chain snapshot instead of producing a reassuring health report", async () => {
  const rpc = fakeRpc(); let reads = 0;
  const original = rpc.call.bind(rpc);
  rpc.call = async (method, params) => {
    if (method === "getblockchaininfo" && ++reads > 1) return { ...rpc.tip, bestblockhash: hex(999) };
    return original(method, params);
  };
  await assert.rejects(probeRegtest(rpc, { genesisHash: hex(1) }), { code: "SCAN_REORG_DETECTED" });
});

test("environment doctor accurately reports missing prerequisites and compose minimum, without installation or Docker daemon access", async () => {
  const report = await doctor({ env: {}, runtime: { docker_cli_version: null, compose_version: null } });
  assert.deepEqual(report.blockers, ["DOCKER_CLI_MISSING", "COMPOSE_2_24_4_REQUIRED", "RPC_URL_NOT_CONFIGURED"]);
  assert.equal(report.rpc.attempted, false); assert.equal(report.runtime.engine_checked, false);
  assert.equal(report.prerequisites_present, false); assert.equal(report.chain_actions_enabled, false);
  for (const v of ["2.24.4", "2.25.0", "3.0.0"]) assert.equal(composeCompatible(v), true);
  for (const v of [null, "1.29.2", "2.24.3", "2.23.9", "bogus"]) assert.equal(composeCompatible(v), false);
  const noPin = await doctor({ env: { EBZ_RPC_URL: "http://127.0.0.1:1/" },
    runtime: { docker_cli_version: "28.0.0", compose_version: "2.24.4" } });
  assert.deepEqual(noPin.blockers, ["GENESIS_PIN_REQUIRED"]); assert.equal(noPin.rpc.attempted, false);
});

test("environment doctor uses a real localhost HTTP 2.0 exchange but never calls declarations proof of live integration", async () => {
  const rpc = fakeRpc();
  const node = await serve((body) => {
    assert.equal(body.jsonrpc, "2.0");
    const result = body.method === "getblockchaininfo" ? rpc.tip : body.method === "getblockhash" ?
      hex(body.params[0] + 1) : rpc.discovery;
    return { jsonrpc: "2.0", id: body.id, result };
  });
  try {
    const options = { env: { EBZ_RPC_URL: node.url, EBZ_REGTEST_GENESIS_HASH: hex(1),
      EBZ_RPC_USER: "public-test-user", EBZ_RPC_PASSWORD: "PUBLIC_TEST_PASSWORD" },
    runtime: { docker_cli_version: "28.0.0", compose_version: "2.24.4" } };
    let report = await doctor(options);
    assert.equal(report.prerequisites_present, true); assert.equal(report.chain_actions_enabled, false);
    assert.equal(report.real_memo_integration_test_complete, false);
    const text = JSON.stringify(report);
    for (const secret of ["public-test-user", "PUBLIC_TEST_PASSWORD", node.url]) assert.ok(!text.includes(secret));
    rpc.tip.initial_block_download_complete = false;
    rpc.discovery.methods.pop();
    report = await doctor(options);
    assert.deepEqual(report.blockers, ["NODE_SYNC_NOT_CONFIRMED", "REQUIRED_RPC_METHODS_MISSING"]);
    assert.ok(node.calls.every((call) => ["getblockchaininfo", "getblockhash", "rpc.discover"].includes(call.method)));
  } finally { await node.close(); }
});

test("doctor sanitizes remote RPC diagnostics and rejects non-local URLs", async () => {
  const runtime = { docker_cli_version: "28.0.0", compose_version: "2.24.4" };
  let report = await doctor({ runtime, env: { EBZ_RPC_URL: "https://node.example/?password=PRIVATE_DETAIL",
    EBZ_REGTEST_GENESIS_HASH: hex(1) } });
  assert.deepEqual(report.blockers, ["LOCAL_RPC_ONLY"]);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_DETAIL"));
  const node = await serve((body) => ({ jsonrpc: "2.0", id: body.id,
    error: { code: -1, message: "PRIVATE_DETAIL" } }));
  try {
    report = await doctor({ runtime, env: { EBZ_RPC_URL: node.url, EBZ_REGTEST_GENESIS_HASH: hex(1) } });
    assert.deepEqual(report.blockers, ["RPC_REMOTE_ERROR"]);
    assert.ok(!JSON.stringify(report).includes("PRIVATE_DETAIL"));
  } finally { await node.close(); }
});
