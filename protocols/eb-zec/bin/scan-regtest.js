const fs = require("node:fs");
const path = require("node:path");
const { ReadonlyRpc } = require("../adapters/readonly-rpc");
const { scanRegtest } = require("../adapters/zcashd-regtest");
const { ensure, canonical } = require("../lib/crypto");

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  ensure(/^\d{1,10}$/.test(raw), "INVALID_SCAN_CONFIGURATION");
  return Number(raw);
}

async function main() {
  ensure(process.argv.length <= 3, "INVALID_SCAN_ARGUMENTS");
  const outputDir = path.resolve(__dirname, "../output");
  const filename = process.argv[2] || "regtest-observation.json";
  ensure(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/.test(filename), "OUTPUT_FILENAME_ONLY");
  // Reject link-based escapes from the ignored output directory; never overwrite existing captures.
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  ensure(!fs.lstatSync(outputDir).isSymbolicLink() && fs.realpathSync(outputDir) === outputDir, "UNSAFE_OUTPUT_DIRECTORY");
  ensure(!fs.existsSync(path.join(outputDir, filename)), "OUTPUT_ALREADY_EXISTS");
  ensure(process.env.EBZ_REGTEST_FROM_HEIGHT !== undefined, "START_HEIGHT_REQUIRED");
  const rpc = new ReadonlyRpc({ url: process.env.EBZ_RPC_URL || "http://127.0.0.1:18232/",
    username: process.env.EBZ_RPC_USER || "", password: process.env.EBZ_RPC_PASSWORD || "" });
  const observation = await scanRegtest(rpc, {
    mailbox: process.env.EBZ_REGTEST_MAILBOX,
    genesisHash: process.env.EBZ_REGTEST_GENESIS_HASH,
    fromHeight: numberEnv("EBZ_REGTEST_FROM_HEIGHT"),
    confirmationDepth: numberEnv("EBZ_REGTEST_CONFIRMATIONS", 2),
    maxBlocks: numberEnv("EBZ_REGTEST_MAX_BLOCKS", 100),
  });
  fs.writeFileSync(path.join(outputDir, filename), canonical(observation), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ network: "regtest", range: observation.range, candidates: observation.candidates.length,
    valid_envelopes: observation.candidates.filter((item) => item.envelope_valid).length,
    observation_hash: observation.observation_hash, output: path.join(outputDir, filename),
    protocol_state_applied: false, broadcast_supported: false }, null, 2));
}

main().catch((error) => { console.error(error.code || "REGTEST_SCAN_FAILED"); process.exitCode = 1; });
