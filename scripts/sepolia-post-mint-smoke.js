const fs = require("fs");
const { ethers } = require("ethers");

const rpcUrl = process.argv[2] || "";
const gameAddress = process.argv[3] || "";
const claimReportPath = process.argv[4] || "reports/sepolia-bulk-commit-400.claim.json";
const sampleCount = Number(process.argv[5] || "5");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-post-mint-smoke.js <rpcUrl> <gameAddress> <claimReportPath> [sampleCount]",
      "",
      "Example:",
      "  node scripts/sepolia-post-mint-smoke.js https://ethereum-sepolia.publicnode.com 0xGame reports/sepolia-bulk-commit-400.claim.json 5",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
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

  throw new Error(`unexpected URI prefix for ${mimeType}: ${uri.slice(0, 60)}`);
}

async function main() {
  if (!rpcUrl || !gameAddress || !claimReportPath) {
    usage();
    process.exit(1);
  }

  const claimReport = readJson(claimReportPath);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const ore = new ethers.Contract(await game.ore(), oreArtifact.abi, provider);

  const claims = (claimReport.claims || []).filter((claim) => claim.ok && claim.tokenId);
  if (claims.length === 0) throw new Error("claim report has no minted tokenIds");

  const samples = [];
  for (const claim of claims.slice(0, sampleCount)) {
    const tokenId = BigInt(claim.tokenId);
    const [owner, being, hunt, cooldownUntil, tokenURI] = await Promise.all([
      game.ownerOf(tokenId),
      game.getBeing(tokenId),
      game.hunts(tokenId),
      game.cooldownUntil(tokenId),
      game.tokenURI(tokenId),
    ]);
    const jsonText = decodeDataUri(tokenURI, "application/json");
    const metadata = JSON.parse(jsonText);
    samples.push({
      tokenId: tokenId.toString(),
      owner,
      expectedOwner: claim.address,
      ownerMatches: owner.toLowerCase() === claim.address.toLowerCase(),
      mass: being.mass.toString(),
      complexity: being.complexity.toString(),
      power: being.power.toString(),
      skill: being.skill.toString(),
      stage: being.stage.toString(),
      lineageMask: being.lineageMask.toString(),
      huntOwner: hunt.owner,
      cooldownUntil: cooldownUntil.toString(),
      tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
      metadataName: metadata.name,
      hasSvgImage:
        typeof metadata.image === "string" &&
        (metadata.image.startsWith("data:image/svg+xml;base64,") || metadata.image.startsWith("data:image/svg+xml;utf8,")),
      attributes: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
    });
  }

  const status = {
    blockNumber: await provider.getBlockNumber(),
    totalMinted: (await game.totalMinted()).toString(),
    aliveSupply: (await game.aliveSupply()).toString(),
    totalEmitted: (await game.totalEmitted()).toString(),
    availableEmission: (await game.availableEmission()).toString(),
    oreTotalSupply: (await ore.totalSupply()).toString(),
    samples,
  };
  console.log(JSON.stringify(status, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
