const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (!uri.startsWith(base64Prefix)) throw new Error(`unexpected ${mimeType} URI prefix`);
  return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
}

async function main() {
  if (!fs.existsSync("artifacts/EternalRenderer.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const signer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const renderer = await factory.deploy();
  await renderer.waitForDeployment();

  const max64 = (1n << 64n) - 1n;
  const max32 = (1n << 32n) - 1n;
  const cases = [
    { label: "fresh", mass: 1n, complexity: 4n, devours: 0n, fusions: 0n, premium: 0n, mark: 0n, power: 3, skill: 7, scars: 0, stage: 2, lineage: 1 },
    { label: "ten-thousand", mass: 10_001n, complexity: 10_004n, devours: 10_000n, fusions: 100n, premium: 20n, mark: 1n << 56n, power: 200, skill: 200, scars: 10, stage: 14, lineage: 63 },
    { label: "million", mass: 1_000_001n, complexity: 2_000_004n, devours: 1_000_000n, fusions: 10_000n, premium: 2000n, mark: (4n << 60n) | (4n << 56n) | 999_999n, power: 10_000, skill: 10_000, scars: 500, stage: 20, lineage: 63 },
    { label: "trillion", mass: 1_000_000_000_001n, complexity: 2_000_000_000_004n, devours: 1_000_000_000_000n, fusions: 1_000_000n, premium: 500_000n, mark: (4n << 60n) | (4n << 56n) | 999_999_999n, power: 1_000_000, skill: 1_000_000, scars: 50_000, stage: 20, lineage: 63 },
    { label: "uint64-max-counters", mass: max64, complexity: max64, devours: max64, fusions: max64, premium: max64, mark: max64, power: Number(max32), skill: Number(max32), scars: Number(max32), stage: 20, lineage: 63 },
  ];

  const results = [];
  for (const item of cases) {
    const tokenUri = await renderer.tokenURI(
      9999n,
      item.mass,
      item.complexity,
      item.devours,
      item.fusions,
      item.premium,
      item.mark,
      item.power,
      item.skill,
      item.scars,
      item.stage,
      item.lineage,
      ethers.keccak256(ethers.toUtf8Bytes(item.label)),
    );
    const metadata = JSON.parse(decodeDataUri(tokenUri, "application/json"));
    const svg = decodeDataUri(metadata.image, "image/svg+xml");
    const tokenURIBytes = Buffer.byteLength(tokenUri, "utf8");
    const svgBytes = Buffer.byteLength(svg, "utf8");
    assert(tokenUri.startsWith("data:application/json;base64,"), `${item.label} tokenURI prefix`);
    assert(metadata.image.startsWith("data:image/svg+xml;base64,"), `${item.label} image prefix`);
    assert(svgBytes < 80_000, `${item.label} SVG remains bounded`);
    assert(tokenURIBytes < 130_000, `${item.label} tokenURI remains bounded`);
    results.push({ label: item.label, svgBytes, tokenURIBytes, attributes: metadata.attributes.length });
  }

  console.log(JSON.stringify({ status: "renderer-stress-test ok", results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
