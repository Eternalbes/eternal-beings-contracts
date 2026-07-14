const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/token-metadata.js <rpcUrl> <gameAddress> <tokenId> [outSvgPath]",
      "",
      "Reads tokenURI(), decodes the JSON metadata, and optionally writes the SVG image to a file.",
    ].join("\n"),
  );
}

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (uri.startsWith(base64Prefix)) {
    return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
  }

  const utf8Prefix = `data:${mimeType};utf8,`;
  if (uri.startsWith(utf8Prefix)) {
    return decodeURIComponent(uri.slice(utf8Prefix.length));
  }

  throw new Error(`Unexpected data URI prefix for ${mimeType}: ${uri.slice(0, 60)}`);
}

async function main() {
  const [rpcUrl, gameAddress, tokenIdRaw, outSvgPath] = process.argv.slice(2);
  if (!rpcUrl || !gameAddress || tokenIdRaw === undefined) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const tokenId = BigInt(tokenIdRaw);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const tokenURI = await game.tokenURI(tokenId);

  const jsonText = decodeDataUri(tokenURI, "application/json");
  const metadata = JSON.parse(jsonText);
  const svg = decodeDataUri(metadata.image, "image/svg+xml");

  if (outSvgPath) {
    fs.writeFileSync(outSvgPath, `${svg}\n`);
  }

  console.log(
    JSON.stringify(
      {
        gameAddress,
        tokenId: tokenId.toString(),
        name: metadata.name,
        description: metadata.description,
        attributeCount: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
        attributes: metadata.attributes,
        tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
        svgBytes: Buffer.byteLength(svg, "utf8"),
        outSvgPath: outSvgPath || null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
