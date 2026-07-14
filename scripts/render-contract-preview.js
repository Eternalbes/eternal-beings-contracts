const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));

function packMark(luck, glyphRank = 0n, borderRank = 0n) {
  return (BigInt(luck) & 0x00ffffffffffffffn) | (BigInt(glyphRank) << 56n) | (BigInt(borderRank) << 60n);
}

const states = {
  start: {
    tokenId: 4096,
    mass: 1n,
    complexity: 1n,
    devours: 0n,
    fusions: 0n,
    premiumDevours: 0n,
    markLuck: 0n,
    power: 7,
    skill: 4,
    scars: 0,
    stage: 1,
    lineageMask: 1,
    genome: "0x3f6a111e4fd91b728dfad54a1a5cbf337079e5cefd9f582bd9913cd7485092aa",
  },
  small: {
    tokenId: 4096,
    mass: 120n,
    complexity: 30n,
    devours: 10n,
    fusions: 0n,
    premiumDevours: 0n,
    markLuck: 0n,
    power: 11,
    skill: 6,
    scars: 0,
    stage: 2,
    lineageMask: 1,
    genome: "0x3f6a111e4fd91b728dfad54a1a5cbf337079e5cefd9f582bd9913cd7485092aa",
  },
  many: {
    tokenId: 4096,
    mass: 2400n,
    complexity: 620n,
    devours: 120n,
    fusions: 0n,
    premiumDevours: 0n,
    markLuck: 0n,
    power: 62,
    skill: 45,
    scars: 0,
    stage: 7,
    lineageMask: 1,
    genome: "0x3f6a111e4fd91b728dfad54a1a5cbf337079e5cefd9f582bd9913cd7485092aa",
  },
  mutated: {
    tokenId: 4096,
    mass: 2700n,
    complexity: 780n,
    devours: 120n,
    fusions: 3n,
    premiumDevours: 6n,
    markLuck: packMark(12500n, 2n, 1n),
    power: 71,
    skill: 51,
    scars: 1,
    stage: 7,
    lineageMask: 1 | 16,
    genome: "0xa6e88d394fa7f9bb6c16b934a00a9ec65ca90210fa18d408a2c7513dd64f8409",
  },
  supercomplex: {
    tokenId: 4096,
    mass: 5640n,
    complexity: 2220n,
    devours: 360n,
    fusions: 13n,
    premiumDevours: 24n,
    markLuck: packMark(145000n, 4n, 4n),
    power: 142,
    skill: 118,
    scars: 8,
    stage: 10,
    lineageMask: 1 | 2 | 4 | 8 | 16 | 32,
    genome: "0xff31c0d99b3e7a142ed5aef9cce48f4fe2eaf65d8efc91b7c34d99fb163a7ae0",
  },
};

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (uri.startsWith(base64Prefix)) {
    return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
  }

  const utf8Prefix = `data:${mimeType};utf8,`;
  if (uri.startsWith(utf8Prefix)) {
    return decodeURIComponent(uri.slice(utf8Prefix.length));
  }

  throw new Error(`unexpected URI prefix for ${mimeType}: ${uri.slice(0, 60)}`);
}

function extractSvg(tokenUri) {
  const metadata = JSON.parse(decodeDataUri(tokenUri, "application/json"));
  return decodeDataUri(metadata.image, "image/svg+xml");
}

async function main() {
  const mode = process.argv[2] || "mutated";
  const s = states[mode] || states.mutated;
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const signer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const renderer = await factory.deploy();
  await renderer.waitForDeployment();

  const tokenUri = await renderer.tokenURI(
    s.tokenId,
    s.mass,
    s.complexity,
    s.devours,
    s.fusions,
    s.premiumDevours,
    s.markLuck,
    s.power,
    s.skill,
    s.scars,
    s.stage,
    s.lineageMask,
    s.genome,
  );

  fs.mkdirSync("reports", { recursive: true });
  const out = `reports/contract-formula-${mode}.svg`;
  fs.writeFileSync(out, `${extractSvg(tokenUri)}\n`);
  console.log(out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
