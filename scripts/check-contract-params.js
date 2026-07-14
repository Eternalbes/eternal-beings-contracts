const fs = require("fs");

const [profileArg = "testnet-fast"] = process.argv.slice(2);
const profilePath = profileArg.endsWith(".json") ? profileArg : `config/contract-params.${profileArg}.json`;
const sourcePath = "src/EternalBeings.sol";

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function sourceConstant(source, type, name) {
  const pattern = new RegExp(`${type}\\s+public\\s+constant\\s+${name}\\s*=\\s*([^;]+);`);
  const match = source.match(pattern);
  if (!match) throw new Error(`missing source constant ${name}`);
  return match[1].trim();
}

function normalize(value) {
  return String(value).replace(/_/g, "").trim();
}

function main() {
  const profile = readJson(profilePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const constants = profile.constants || {};
  const entries = [
    ["uint256", "EPOCH_BLOCKS"],
    ["uint256", "COMMIT_BLOCKS"],
    ["uint256", "MINTS_PER_EPOCH"],
    ["uint256", "MAX_ENDURANCE"],
    ["uint256", "COOLDOWN_BLOCKS"],
    ["uint256", "UNKNOWN_HOLD_BLOCKS"],
    ["uint256", "CRYPTOPUNK_OBSERVATION_BLOCKS"],
    ["uint256", "UNKNOWN_MIN_TOTAL_SUPPLY"],
    ["uint32", "UNKNOWN_COLLECTION_DEVOUR_LIMIT"],
    ["uint96", "ROYALTY_BPS"],
  ];

  const mismatches = [];
  const actual = {};
  for (const [type, name] of entries) {
    if (constants[name] === undefined) continue;
    const sourceValue = sourceConstant(source, type, name);
    actual[name] = sourceValue;
    if (normalize(sourceValue) !== normalize(constants[name])) {
      mismatches.push({ name, expected: String(constants[name]), actual: sourceValue });
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    profile: profile.profile || profileArg,
    profilePath,
    sourcePath,
    constants: actual,
    mismatches,
    ok: mismatches.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main();
