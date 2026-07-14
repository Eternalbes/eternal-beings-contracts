const fs = require("fs");

const profileArg = process.argv[2] || "mainnet";
const profilePath = profileArg.endsWith(".json")
  ? profileArg
  : `config/contract-params.${profileArg}.json`;

if (!fs.existsSync(profilePath)) {
  console.error(`Missing parameter profile: ${profilePath}`);
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
const constants = profile.constants || {};
const sourcePath = "src/EternalBeings.sol";
let source = fs.readFileSync(sourcePath, "utf8");

const replacements = [
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

for (const [type, name] of replacements) {
  if (constants[name] === undefined) continue;
  const value = String(constants[name]);
  const pattern = new RegExp(`(${type}\\s+public\\s+constant\\s+${name}\\s*=\\s*)[^;]+;`);
  if (!pattern.test(source)) {
    throw new Error(`Could not find constant ${name} in ${sourcePath}`);
  }
  source = source.replace(pattern, `$1${value};`);
}

fs.writeFileSync(sourcePath, source);
console.log(
  JSON.stringify(
    {
      appliedProfile: profile.profile || profileArg,
      profilePath,
      sourcePath,
      constants,
    },
    null,
    2,
  ),
);
