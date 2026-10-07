const { execFileSync } = require("node:child_process");
const { ReadonlyRpc } = require("../adapters/readonly-rpc");
const { probeRegtest } = require("../adapters/regtest-preflight");

function commandVersion(args, pattern) {
  try {
    const output = execFileSync("docker", args, { encoding: "utf8", timeout: 5000, maxBuffer: 65536,
      stdio: ["ignore", "pipe", "ignore"] });
    return output.match(pattern)?.[1] || null;
  } catch { return null; }
}

function composeCompatible(version) {
  if (!version) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)));
}

async function doctor({ env = process.env, runtime } = {}) {
  const detected = runtime || { docker_cli_version: commandVersion(["--version"], /Docker version (\d+\.\d+\.\d+)/),
    compose_version: commandVersion(["compose", "version", "--short"], /v?(\d+\.\d+\.\d+)/) };
  const blockers = [];
  if (!detected.docker_cli_version) blockers.push("DOCKER_CLI_MISSING");
  if (!composeCompatible(detected.compose_version)) blockers.push("COMPOSE_2_24_4_REQUIRED");
  let rpc = { attempted: false };
  if (!env.EBZ_RPC_URL) blockers.push("RPC_URL_NOT_CONFIGURED");
  else if (!env.EBZ_REGTEST_GENESIS_HASH) blockers.push("GENESIS_PIN_REQUIRED");
  else {
    try {
      const client = new ReadonlyRpc({ url: env.EBZ_RPC_URL, username: env.EBZ_RPC_USER || "",
        password: env.EBZ_RPC_PASSWORD || "", jsonrpcVersion: "2.0", timeoutMs: 3000 });
      rpc = { attempted: true, ...await probeRegtest(client, { genesisHash: env.EBZ_REGTEST_GENESIS_HASH }) };
      if (rpc.initial_sync_complete === false) blockers.push("NODE_SYNC_NOT_CONFIRMED");
      if (rpc.discovery.missing_methods.length) blockers.push("REQUIRED_RPC_METHODS_MISSING");
      if (rpc.discovery.ambiguous_methods.length) blockers.push("RPC_ROUTING_AMBIGUOUS");
    } catch (error) {
      rpc = { attempted: true, error_code: error.code || "REGTEST_PREFLIGHT_FAILED" };
      blockers.push(rpc.error_code);
    }
  }
  return { mode: "read-only-regtest-prerequisite-check", runtime: { ...detected, engine_checked: false }, rpc,
    blockers, prerequisites_present: blockers.length === 0, chain_actions_enabled: false,
    real_memo_integration_test_complete: false, protocol_state_applied: false,
    next_step: blockers.length ? "provide-reviewed-regtest-runtime-and-rpc" : "perform-real-memo-integration-test" };
}

if (require.main === module) {
  doctor().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.prerequisites_present ? 0 : 2;
  }).catch(() => { console.error("REGTEST_PREFLIGHT_FAILED"); process.exitCode = 1; });
}

module.exports = { doctor, composeCompatible };
