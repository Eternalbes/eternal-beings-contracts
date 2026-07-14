const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/being-status.js <rpcUrl> <gameAddress> <tokenId>",
      "",
      "Reads owner, Being attributes, Hunt lock state, and cooldown state.",
    ].join("\n"),
  );
}

function asObjectBeing(being) {
  return {
    mass: being.mass.toString(),
    complexity: being.complexity.toString(),
    devours: being.devours.toString(),
    fusions: being.fusions.toString(),
    huntNonce: being.huntNonce.toString(),
    power: being.power.toString(),
    skill: being.skill.toString(),
    scars: being.scars.toString(),
    stage: being.stage.toString(),
    originClass: being.originClass.toString(),
    originSymbol: being.originSymbol.toString(),
    mutationBias: being.mutationBias.toString(),
    lineageMask: being.lineageMask.toString(),
    genome: being.genome,
  };
}

async function main() {
  const [rpcUrl, gameAddress, tokenIdRaw] = process.argv.slice(2);
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

  const [blockNumberRaw, owner, being, hunt, cooldownUntil, tokenURI] = await Promise.all([
    provider.getBlockNumber(),
    game.ownerOf(tokenId),
    game.getBeing(tokenId),
    game.hunts(tokenId),
    game.cooldownUntil(tokenId),
    game.tokenURI(tokenId),
  ]);
  const blockNumber = BigInt(blockNumberRaw);
  const isHunting = hunt.owner !== ethers.ZeroAddress;
  const cooldownRemaining = cooldownUntil > blockNumber ? cooldownUntil - blockNumber : 0n;

  console.log(
    JSON.stringify(
      {
        gameAddress,
        tokenId: tokenId.toString(),
        blockNumber: blockNumber.toString(),
        owner,
        being: asObjectBeing(being),
        hunt: {
          isHunting,
          owner: hunt.owner,
          startBlock: hunt.startBlock.toString(),
          endurance: hunt.endurance.toString(),
          difficulty: hunt.difficulty.toString(),
          sceneId: hunt.sceneId.toString(),
          tokenMultiplier: hunt.tokenMultiplier.toString(),
          powerRate: hunt.powerRate.toString(),
          skillRate: hunt.skillRate.toString(),
        },
        cooldown: {
          cooldownUntil: cooldownUntil.toString(),
          cooldownRemaining: cooldownRemaining.toString(),
          canEnterHuntNow: !isHunting && cooldownRemaining === 0n,
        },
        tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
        suggestedAction: isHunting
          ? "resolveHunt when ready"
          : cooldownRemaining > 0n
            ? "wait for cooldown"
            : "can enterHunt, fuse, or devour if caller is owner",
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
