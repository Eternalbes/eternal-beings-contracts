const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (uri.startsWith(base64Prefix)) {
    return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
  }

  throw new Error(`unexpected URI prefix for ${mimeType}: ${uri.slice(0, 60)}`);
}

function extractSvg(tokenUri) {
  const metadata = JSON.parse(decodeDataUri(tokenUri, "application/json"));
  return decodeDataUri(metadata.image, "image/svg+xml");
}

async function main() {
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const signer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const renderer = await factory.deploy();
  await renderer.waitForDeployment();

  fs.mkdirSync("reports/initial-mint", { recursive: true });
  const outputs = [];
  for (let i = 0; i < 10; i++) {
    const tokenId = 1 + i;
    const genome = ethers.keccak256(ethers.solidityPacked(["string", "uint256"], ["initial-mint-preview", tokenId]));
    const g = BigInt(genome);
    const lineageMask = 1 << (i % 6);
    const tokenUri = await renderer.tokenURI(
      tokenId,
      1,
      Number(1n + (g % 9n)),
      0,
      0,
      0,
      0,
      Number(1n + ((g >> 8n) % 20n)),
      Number(1n + ((g >> 16n) % 20n)),
      0,
      1,
      lineageMask,
      genome,
    );
    const out = `reports/initial-mint/initial-${String(tokenId).padStart(2, "0")}.svg`;
    fs.writeFileSync(out, `${extractSvg(tokenUri)}\n`);
    outputs.push(out);
  }

  console.log(JSON.stringify(outputs, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
