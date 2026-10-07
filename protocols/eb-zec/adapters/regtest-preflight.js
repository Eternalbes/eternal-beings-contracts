const { ensure } = require("../lib/crypto");

const REQUIRED_METHODS = Object.freeze(["getblockchaininfo", "getblockhash", "getblock", "getrawtransaction",
  "z_listunifiedreceivers", "z_listreceivedbyaddress"]);
const HEX32 = /^[0-9a-f]{64}$/;

function inspectDiscovery(schema) {
  ensure(schema && typeof schema.openrpc === "string" && /^1\.\d+\.\d+$/.test(schema.openrpc) &&
    Array.isArray(schema.methods) && schema.methods.length <= 1024, "INVALID_RPC_DISCOVERY");
  const names = new Set(), duplicateRequired = new Set();
  for (const method of schema.methods) {
    ensure(method && typeof method.name === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(method.name),
      "INVALID_RPC_DISCOVERY");
    if (names.has(method.name) && REQUIRED_METHODS.includes(method.name)) duplicateRequired.add(method.name);
    names.add(method.name);
  }
  return { declared_methods: REQUIRED_METHODS.filter((method) => names.has(method)),
    missing_methods: REQUIRED_METHODS.filter((method) => !names.has(method)),
    ambiguous_methods: [...duplicateRequired].sort(), method_count: schema.methods.length,
    capabilities_executed: false };
}

async function probeRegtest(rpc, { genesisHash }) {
  ensure(typeof genesisHash === "string" && HEX32.test(genesisHash), "GENESIS_PIN_REQUIRED");
  const info = await rpc.call("getblockchaininfo");
  // Never reinterpret `test` as regtest, even if a deployment example does so.
  ensure(info && info.chain === "regtest", "REGTEST_RPC_ONLY");
  ensure(Number.isInteger(info.blocks) && info.blocks >= 0 && info.blocks <= 0xffffffff &&
    typeof info.bestblockhash === "string" && HEX32.test(info.bestblockhash), "INVALID_NODE_TIP");
  ensure(await rpc.call("getblockhash", [0]) === genesisHash, "NODE_GENESIS_MISMATCH");
  ensure(await rpc.call("getblockhash", [info.blocks]) === info.bestblockhash, "SCAN_REORG_DETECTED");
  const discovery = inspectDiscovery(await rpc.call("rpc.discover"));
  const current = await rpc.call("getblockchaininfo");
  ensure(current && current.chain === "regtest", "REGTEST_RPC_ONLY");
  ensure(Number.isInteger(current.blocks) && current.blocks >= info.blocks && current.blocks <= 0xffffffff &&
    typeof current.bestblockhash === "string" && HEX32.test(current.bestblockhash) &&
    await rpc.call("getblockhash", [current.blocks]) === current.bestblockhash &&
    await rpc.call("getblockhash", [info.blocks]) === info.bestblockhash &&
    await rpc.call("getblockhash", [0]) === genesisHash, "SCAN_REORG_DETECTED");
  return { network: "regtest", genesis_pin_matches: true, chain_anchor_consistent: true,
    initial_sync_complete: typeof info.initial_block_download_complete === "boolean" ?
      info.initial_block_download_complete : null,
    sync_validation_complete: false,
    anchor_height: info.blocks, discovery,
    mailbox_checked: false, independently_decrypted: false, protocol_state_applied: false,
    real_memo_integration_test_complete: false, broadcast_supported: false };
}

module.exports = { REQUIRED_METHODS, inspectDiscovery, probeRegtest };
