const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/ore-status.js <rpcUrl> <gameAddress> [account] [spender]",
      "",
      "Reads ORE supply, emission cap, available emission, and optional account balance/allowance.",
    ].join("\n"),
  );
}

async function main() {
  const [rpcUrl, gameAddress, accountRaw, spenderRaw] = process.argv.slice(2);
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json") || !fs.existsSync("artifacts/EternalOre.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const gameArtifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const oreArtifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, gameArtifact.abi, provider);

  const [blockNumberRaw, oreAddress, tokenMaxSupply, totalEmitted, emittedCap, availableEmission] = await Promise.all([
    provider.getBlockNumber(),
    game.ore(),
    game.TOKEN_MAX_SUPPLY(),
    game.totalEmitted(),
    game.emittedCap(),
    game.availableEmission(),
  ]);

  const ore = new ethers.Contract(oreAddress, oreArtifact.abi, provider);
  const [name, symbol, decimals, minter, totalSupply] = await Promise.all([
    ore.name(),
    ore.symbol(),
    ore.decimals(),
    ore.minter(),
    ore.totalSupply(),
  ]);

  const output = {
    gameAddress,
    blockNumber: String(blockNumberRaw),
    oreAddress,
    name,
    symbol,
    decimals: decimals.toString(),
    minter,
    tokenMaxSupply: tokenMaxSupply.toString(),
    totalSupply: totalSupply.toString(),
    totalEmitted: totalEmitted.toString(),
    emittedCap: emittedCap.toString(),
    availableEmission: availableEmission.toString(),
    supplyWithinCap: totalSupply <= emittedCap && totalSupply <= tokenMaxSupply,
  };

  if (accountRaw) {
    const account = ethers.getAddress(accountRaw.toLowerCase());
    output.account = {
      address: account,
      balance: (await ore.balanceOf(account)).toString(),
    };
    if (spenderRaw) {
      const spender = ethers.getAddress(spenderRaw.toLowerCase());
      output.account.spender = spender;
      output.account.allowance = (await ore.allowance(account, spender)).toString();
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
