const fs = require("fs");

const source = fs.readFileSync("src/EternalBeings.sol", "utf8");
const MAX_RUNTIME_BYTES = 24_576;
const RUNTIME_WARNING_BYTES = 23_500;
const MAX_INITCODE_BYTES = 49_152;
const INITCODE_WARNING_BYTES = 48_000;

const forbidden = [
  /\bonlyOwner\b/,
  /\bownerMint\b/,
  /\badminMint\b/,
  /\bwithdraw\w*\s*\(/,
  /\brescue\w*\s*\(/,
  /\bupgrade\w*\s*\(/,
  /\bpause\w*\s*\(/,
  /\bexecute\s*\(/,
  /\bdelegatecall\b/,
  /\bselfdestruct\b/,
  /\btx\.origin\b/,
  /\bOwnable\b/,
  /\bAccessControl\b/,
  /\bunchecked\b/,
  /\bsetTier\s*\(/,
  /\bsetEmission\s*\(/,
  /\bsetPower\s*\(/,
  /\bsetSkill\s*\(/,
  /\bsetGenome\s*\(/,
];

for (const pattern of forbidden) {
  if (pattern.test(source)) {
    console.error(`Forbidden pattern found: ${pattern}`);
    process.exit(1);
  }
}

if (fs.existsSync("artifacts")) {
  for (const name of ["EternalBeings", "EternalRenderer"]) {
    const artifactPath = `artifacts/${name}.json`;
    if (!fs.existsSync(artifactPath)) continue;
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const bytes = artifact.deployedBytecode.replace(/^0x/, "").length / 2;
    const initBytes = artifact.bytecode.replace(/^0x/, "").length / 2;
    if (bytes >= MAX_RUNTIME_BYTES) {
      console.error(`${name} runtime ${bytes} bytes exceeds EIP-170 ${MAX_RUNTIME_BYTES} byte limit`);
      process.exit(1);
    }
    if (bytes >= RUNTIME_WARNING_BYTES) {
      console.error(`${name} runtime ${bytes} bytes leaves too little renderer/game headroom`);
      process.exit(1);
    }
    if (initBytes >= MAX_INITCODE_BYTES) {
      console.error(`${name} initcode ${initBytes} bytes exceeds EIP-3860 ${MAX_INITCODE_BYTES} byte limit`);
      process.exit(1);
    }
    if (initBytes >= INITCODE_WARNING_BYTES) {
      console.error(`${name} initcode ${initBytes} bytes leaves too little deployment headroom`);
      process.exit(1);
    }
  }
}

console.log("static-check ok");
