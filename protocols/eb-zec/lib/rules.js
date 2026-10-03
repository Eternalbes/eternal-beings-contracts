const fs = require("node:fs");
const path = require("node:path");
const { hash, b64, canonical, ensure, add, bytes } = require("./crypto");

const LINEAGES = ["Mechanical", "Idol", "Citadel", "Crystal", "Star", "Rune"];
const RULESET = Object.freeze({
  id: "eb-zec-local-reference-0.1",
  max_attribute: 4294967295,
  resource_cap_units: 2100000000000000,
  resource_decimals: 8,
  emission_per_block_units: 1000,
  evolution_beacon_delay_blocks: 2,
  mutation_chance_bp: 100,
  devour_glyph_chance_bp: 5,
  fuse_glyph_chance_bp: 50,
  mutate_glyph_chance_bp: 20,
  devour_border_chance_bp: 1,
  fuse_border_chance_bp: 10,
  mutate_border_chance_bp: 5,
  max_glyph_rows: 32,
  scenes: [
    { id: 0, minimum_blocks: 2, maximum_blocks: 100, difficulty: 1, reward_units_per_block: 20 },
    { id: 1, minimum_blocks: 4, maximum_blocks: 200, difficulty: 4, reward_units_per_block: 10 },
    { id: 2, minimum_blocks: 8, maximum_blocks: 400, difficulty: 16, reward_units_per_block: 4 },
  ],
});

function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeTree(child);
  return Object.freeze(value);
}
freezeTree(RULESET);
Object.freeze(LINEAGES);

function rulesetId() {
  const files = ["crypto.js", "memo.js", "rules.js", "profile.js", "indexer.js"].map((name) =>
    [name, fs.readFileSync(path.join(__dirname, name), "utf8")]);
  files.push(["schema", canonical(require("../../../docs/zcash/eb-zec-v1.schema.json"))]);
  files.push(["dependencies", canonical(require("../package.json").dependencies)]);
  return b64(hash(canonical(files)));
}

function roll(entropy, domain) {
  let attempt = 0;
  while (true) {
    const candidate = hash("EBZ_ROLL_LOCAL_V01", entropy, domain, String(attempt++)).readUInt32LE(0);
    if (candidate < 4294960000) return candidate % 10000;
  }
}
function initialTraits(genome) {
  const seed = bytes(genome, 32);
  const weights = Array(6).fill(0);
  weights[seed[0] % 6] = 10000;
  return { lineage_mask: 1 << (seed[0] % 6), lineage_weights: weights, glyph_rows: 0, border: false };
}

function mixLineages(parent, donor) {
  const raw = parent.map((weight, i) => weight * 3 + donor[i]);
  const weights = raw.map((weight) => Math.floor(weight / 4));
  const largest = raw.indexOf(Math.max(...raw));
  weights[largest] += 10000 - weights.reduce((sum, weight) => sum + weight, 0);
  return weights;
}

function bonusTraits(being, entropy, mode) {
  const glyphRoll = roll(entropy, "glyph");
  const borderRoll = roll(entropy, "border");
  if (glyphRoll < RULESET[`${mode}_glyph_chance_bp`]) {
    being.glyph_rows = Math.min(RULESET.max_glyph_rows, being.glyph_rows + 1);
  }
  if (borderRoll < RULESET[`${mode}_border_chance_bp`]) being.border = true;
}

function evolve(being, event, mode, donor, beacon) {
  ensure(typeof beacon === "string" && /^[0-9a-f]{64}$/.test(beacon), "EVOLUTION_BEACON_REQUIRED");
  const entropy = hash("EBZ_EVOLVE_LOCAL_V01", bytes(being.genome, 32), bytes(event, 32),
    mode, donor ? bytes(donor.genome, 32) : Buffer.alloc(0), Buffer.from(beacon, "hex"));
  being.genome = b64(entropy);
  if (mode === "fuse") {
    being.lineage_weights = mixLineages(being.lineage_weights, donor.lineage_weights);
    being.lineage_mask |= donor.lineage_mask;
    being.fusions = add(being.fusions, 1);
    being.mass = add(being.mass, 2, RULESET.max_attribute);
    being.complexity = add(being.complexity, 2, RULESET.max_attribute);
  } else if (mode === "devour") {
    being.devours = add(being.devours, 1);
    being.mass = add(being.mass, 1, RULESET.max_attribute);
    being.complexity = add(being.complexity, 1, RULESET.max_attribute);
  } else if (roll(entropy, "mutation") < RULESET.mutation_chance_bp) {
    const donorWeights = Array(6).fill(0);
    donorWeights[entropy[6] % 6] = 10000;
    being.lineage_weights = mixLineages(being.lineage_weights, donorWeights);
    being.lineage_mask |= 1 << (entropy[6] % 6);
    being.mutations = add(being.mutations, 1);
  }
  bonusTraits(being, entropy, mode);
  being.stage = being.complexity < 4 ? 0 : being.complexity < 12 ? 1 : being.complexity < 40 ? 2 : 3;
}

function huntReward(being, hunt, height, issued, genesisHeight) {
  const scene = RULESET.scenes.find((item) => item.id === hunt.scene);
  ensure(scene, "UNKNOWN_SCENE");
  const elapsed = height - hunt.height;
  ensure(elapsed >= scene.minimum_blocks, "HUNT_TOO_EARLY");
  const endurance = Math.min(scene.maximum_blocks, Math.max(1,
    Math.floor((being.power + being.skill) / scene.difficulty)));
  const worked = Math.min(elapsed, endurance);
  const proposed = BigInt(worked) * BigInt(scene.reward_units_per_block);
  const unlocked = BigInt(height - genesisHeight) * BigInt(RULESET.emission_per_block_units);
  const limit = unlocked < BigInt(RULESET.resource_cap_units) ? unlocked : BigInt(RULESET.resource_cap_units);
  const available = limit > BigInt(issued) ? limit - BigInt(issued) : 0n;
  return Number(proposed < available ? proposed : available);
}

module.exports = { RULESET, LINEAGES, rulesetId, initialTraits, mixLineages, evolve, huntReward, roll };
