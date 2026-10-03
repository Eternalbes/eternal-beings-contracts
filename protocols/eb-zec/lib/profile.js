const { ensure, bytes, hash, b64, canonical } = require("./crypto");
const { rulesetId } = require("./rules");
const { rendererId } = require("./renderer");

const FIELDS = ["protocol", "protocol_major", "protocol_minor", "network", "world_id", "genesis_height",
  "protocol_ua", "protocol_uivk", "carrier_value_zat", "confirmation_depth", "commit_blocks",
  "beacon_delay_blocks", "reveal_blocks", "mint_slots_per_round", "max_supply", "renderer_id",
  "ruleset_id", "release_key"];

function validateManifest(manifest) {
  ensure(manifest && Object.getPrototypeOf(manifest) === Object.prototype, "INVALID_MANIFEST");
  ensure(Object.keys(manifest).length === FIELDS.length && FIELDS.every((field) => Object.hasOwn(manifest, field)),
    "INVALID_MANIFEST_FIELDS");
  ensure(manifest.protocol === "ebz" && manifest.protocol_major === 0 && manifest.protocol_minor === 1,
    "UNSUPPORTED_PROFILE");
  ensure(manifest.network === 2, "LOCAL_REGTEST_ONLY");
  bytes(manifest.world_id, 16);
  for (const field of ["renderer_id", "ruleset_id", "release_key"]) bytes(manifest[field], 32);
  for (const field of ["genesis_height", "carrier_value_zat"]) {
    ensure(Number.isSafeInteger(manifest[field]) && manifest[field] >= 0 && manifest[field] <= 0xffffffff,
      "INVALID_MANIFEST_INTEGER");
  }
  for (const field of ["confirmation_depth", "commit_blocks", "beacon_delay_blocks", "reveal_blocks",
    "mint_slots_per_round", "max_supply"]) {
    ensure(Number.isInteger(manifest[field]) && manifest[field] > 0 && manifest[field] <= 65535,
      "INVALID_MANIFEST_INTEGER");
  }
  ensure(manifest.max_supply <= 333 && manifest.mint_slots_per_round <= manifest.max_supply,
    "PILOT_SUPPLY_LIMIT");
  ensure(typeof manifest.protocol_ua === "string" && manifest.protocol_ua.startsWith("local:") &&
    typeof manifest.protocol_uivk === "string" && manifest.protocol_uivk.startsWith("local:"),
  "LOCAL_ADAPTER_ONLY");
  ensure(manifest.ruleset_id === rulesetId() && manifest.renderer_id === rendererId(), "RELEASE_HASH_MISMATCH");
  return structuredClone(manifest);
}

function manifestHash(manifest) { return b64(hash(canonical(manifest))); }
function roundWindow(manifest, round) {
  ensure(Number.isSafeInteger(round) && round >= 0, "INVALID_ROUND");
  const length = manifest.commit_blocks + manifest.beacon_delay_blocks + manifest.reveal_blocks;
  const start = manifest.genesis_height + 1 + round * length;
  ensure(Number.isSafeInteger(start + length) && start + length <= 0xffffffff, "ROUND_OVERFLOW");
  const commitEnd = start + manifest.commit_blocks - 1;
  const beacon = commitEnd + manifest.beacon_delay_blocks;
  return { round, start, commit_end: commitEnd, beacon_height: beacon, reveal_start: beacon + 1,
    reveal_end: beacon + manifest.reveal_blocks };
}

module.exports = { validateManifest, manifestHash, roundWindow };
