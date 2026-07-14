const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/postdeploy-check.js <rpcUrl> <gameAddress> <expectedRoot> <expectedRoyaltyReceiver>",
      "",
      "Example:",
      "  node scripts/postdeploy-check.js $RPC_URL 0xGame... 0xRoot... 0xRoyalty...",
    ].join("\n"),
  );
}

function byteLength(hex) {
  return (hex.replace(/^0x/, "").length / 2) | 0;
}

function assertEqual(actual, expected, message) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const [rpcUrl, gameAddress, expectedRoot, expectedRoyaltyReceiver] = process.argv.slice(2);
  if (!rpcUrl || !gameAddress || !expectedRoot || !expectedRoyaltyReceiver) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);

  const code = await provider.getCode(gameAddress);
  if (code === "0x") throw new Error("No bytecode at game address");

  const [
    name,
    symbol,
    maxBeings,
    tokenMaxSupply,
    emissionPerBlock,
    topCollectionsRoot,
    royaltyReceiver,
    oreAddress,
    rendererAddress,
    totalMinted,
    aliveSupply,
    totalEmitted,
    emittedCap,
  ] = await Promise.all([
    game.name(),
    game.symbol(),
    game.MAX_BEINGS(),
    game.TOKEN_MAX_SUPPLY(),
    game.EMISSION_PER_BLOCK(),
    game.topCollectionsRoot(),
    game.royaltyReceiver(),
    game.ore(),
    game.renderer(),
    game.totalMinted(),
    game.aliveSupply(),
    game.totalEmitted(),
    game.emittedCap(),
  ]);

  assertEqual(name, "Eternal Beings", "name mismatch");
  assertEqual(symbol, "BEING", "symbol mismatch");
  assertEqual(maxBeings, 9999n, "MAX_BEINGS mismatch");
  assertEqual(tokenMaxSupply, ethers.parseEther("21000000"), "TOKEN_MAX_SUPPLY mismatch");
  assertEqual(topCollectionsRoot, expectedRoot, "topCollectionsRoot mismatch");
  assertEqual(royaltyReceiver, expectedRoyaltyReceiver, "royaltyReceiver mismatch");

  const ore = new ethers.Contract(oreAddress, oreArtifact.abi, provider);
  const [oreName, oreSymbol, oreMinter, oreTotalSupply] = await Promise.all([
    ore.name(),
    ore.symbol(),
    ore.minter(),
    ore.totalSupply(),
  ]);
  assertEqual(oreName, "Eternal Ore", "ORE name mismatch");
  assertEqual(oreSymbol, "ORE", "ORE symbol mismatch");
  assertEqual(oreMinter, gameAddress, "ORE minter mismatch");
  if (oreTotalSupply > emittedCap) throw new Error("ORE supply exceeds emittedCap");

  const rendererCode = await provider.getCode(rendererAddress);
  if (rendererCode === "0x") throw new Error("No bytecode at renderer address");

  const royalty = await game.royaltyInfo(1, ethers.parseEther("1"));
  assertEqual(royalty[0], expectedRoyaltyReceiver, "royaltyInfo receiver mismatch");
  assertEqual(royalty[1], ethers.parseEther("0.03"), "royaltyInfo amount mismatch");

  const report = {
    gameAddress,
    codeBytes: byteLength(code),
    name,
    symbol,
    maxBeings: maxBeings.toString(),
    tokenMaxSupply: tokenMaxSupply.toString(),
    emissionPerBlock: emissionPerBlock.toString(),
    topCollectionsRoot,
    royaltyReceiver,
    oreAddress,
    rendererAddress,
    rendererCodeBytes: byteLength(rendererCode),
    totalMinted: totalMinted.toString(),
    aliveSupply: aliveSupply.toString(),
    totalEmitted: totalEmitted.toString(),
    emittedCap: emittedCap.toString(),
    oreTotalSupply: oreTotalSupply.toString(),
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("postdeploy-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
