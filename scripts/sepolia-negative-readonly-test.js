const fs = require("fs");
const { ethers } = require("ethers");

const [rpcUrl, gameAddress, liveTokenRaw = "1", burnedTokenRaw = "2", outputPath = "reports/sepolia-fast-v4-negative-readonly-test.json"] =
  process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-negative-readonly-test.js <rpcUrl> <gameAddress> [liveTokenId] [burnedTokenId] [outputPath]",
      "",
      "Runs Sepolia eth_call-only negative tests. It does not submit transactions or require a private key.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (uri.startsWith(base64Prefix)) return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
  const utf8Prefix = `data:${mimeType};utf8,`;
  if (uri.startsWith(utf8Prefix)) return decodeURIComponent(uri.slice(utf8Prefix.length));
  throw new Error(`unexpected ${mimeType} URI prefix: ${uri.slice(0, 80)}`);
}

async function expectReject(label, fn) {
  try {
    const value = await fn();
    return { label, ok: false, unexpectedValue: String(value) };
  } catch (error) {
    return { label, ok: true, error: error.shortMessage || error.reason || error.message };
  }
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }

  const liveTokenId = BigInt(liveTokenRaw);
  const burnedTokenId = BigInt(burnedTokenRaw);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const gameArtifact = readJson("artifacts/EternalBeings.json");
  const oreArtifact = readJson("artifacts/EternalOre.json");
  const game = new ethers.Contract(gameAddress, gameArtifact.abi, provider);
  const blockNumber = await provider.getBlockNumber();
  const owner = await game.ownerOf(liveTokenId);
  const other = ethers.Wallet.createRandom().address;
  const ownerSigner = new ethers.VoidSigner(owner, provider);
  const otherSigner = new ethers.VoidSigner(other, provider);
  const gameAsOwner = game.connect(ownerSigner);
  const gameAsOther = game.connect(otherSigner);
  const oreAddress = await game.ore();
  const ore = new ethers.Contract(oreAddress, oreArtifact.abi, provider);
  const oreAsOther = ore.connect(otherSigner);

  const tokenURI = await game.tokenURI(liveTokenId);
  const metadata = JSON.parse(decodeDataUri(tokenURI, "application/json"));
  const svg = decodeDataUri(metadata.image, "image/svg+xml");

  const rejected = [
    await expectReject("burned ownerOf reverts", () => game.ownerOf.staticCall(burnedTokenId)),
    await expectReject("burned tokenURI reverts", () => game.tokenURI.staticCall(burnedTokenId)),
    await expectReject("non-owner cannot enter hunt", () => gameAsOther.enterHunt.staticCall(liveTokenId)),
    await expectReject("non-owner cannot fuse two live tokens", () => gameAsOther.fuseBeing.staticCall(1n, 3n)),
    await expectReject("owner cannot self-fuse", () => gameAsOwner.fuseBeing.staticCall(liveTokenId, liveTokenId)),
    await expectReject("devour own collection must use fuse", () => gameAsOwner.devourExternal.staticCall(liveTokenId, gameAddress, liveTokenId)),
    await expectReject("non-minter cannot mint ORE", () => oreAsOther.mint.staticCall(other, 1n)),
    await expectReject("ORE transfer to zero reverts", () => oreAsOther.transfer.staticCall(ethers.ZeroAddress, 1n)),
    await expectReject("balanceOf zero address reverts", () => game.balanceOf.staticCall(ethers.ZeroAddress)),
  ];

  const [totalMinted, aliveSupply, emittedCap, totalEmitted, oreTotalSupply] = await Promise.all([
    game.totalMinted(),
    game.aliveSupply(),
    game.emittedCap(),
    game.totalEmitted(),
    ore.totalSupply(),
  ]);

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    blockNumber,
    liveTokenId: liveTokenId.toString(),
    liveTokenOwner: owner,
    burnedTokenId: burnedTokenId.toString(),
    counters: {
      totalMinted: totalMinted.toString(),
      aliveSupply: aliveSupply.toString(),
      burnedByCounter: (totalMinted - aliveSupply).toString(),
    },
    metadata: {
      tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
      imagePrefix: String(metadata.image || "").slice(0, 30),
      svgBytes: Buffer.byteLength(svg, "utf8"),
      svgStartsWithSvgTag: svg.trimStart().startsWith("<svg"),
      attributes: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
    },
    ore: {
      oreAddress,
      totalSupply: oreTotalSupply.toString(),
      totalEmitted: totalEmitted.toString(),
      emittedCap: emittedCap.toString(),
      supplyWithinCap: oreTotalSupply <= emittedCap,
    },
    rejected,
    ok:
      totalMinted >= aliveSupply &&
      oreTotalSupply <= emittedCap &&
      tokenURI.startsWith("data:application/json;base64,") &&
      String(metadata.image || "").startsWith("data:image/svg+xml;base64,") &&
      svg.trimStart().startsWith("<svg") &&
      Array.isArray(metadata.attributes) &&
      metadata.attributes.length >= 9 &&
      rejected.every((item) => item.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
