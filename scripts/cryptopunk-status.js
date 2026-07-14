const fs = require("fs");
const { ethers } = require("ethers");

const PUNK_ABI = ["function punkIndexToAddress(uint256 punkIndex) view returns (address)"];

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/cryptopunk-status.js <rpcUrl> <gameAddress> <punkContract> <punkId> [account] [proofFile]",
      "",
      "Reads native CryptoPunks-style devour readiness: proof tier, observation, expiry, current Punk owner, and devoured flag.",
    ].join("\n"),
  );
}

function proofEntryFor(proofFile, punkContract) {
  if (!fs.existsSync(proofFile)) return null;
  const proofData = JSON.parse(fs.readFileSync(proofFile, "utf8"));
  const wanted = ethers.getAddress(punkContract.toLowerCase()).toLowerCase();
  const entry = proofData.entries.find((item) => ethers.getAddress(item.address.toLowerCase()).toLowerCase() === wanted);
  return entry
    ? {
        root: proofData.root,
        rank: entry.rank,
        name: entry.name,
        address: ethers.getAddress(entry.address.toLowerCase()),
        tier: entry.tier,
        proof: entry.proof,
      }
    : null;
}

async function optionalCall(fallback, fn) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function main() {
  const [rpcUrl, gameAddress, punkContractRaw, punkIdRaw, accountRaw, proofFile = "reports/top-collections.proofs.json"] =
    process.argv.slice(2);
  if (!rpcUrl || !gameAddress || !punkContractRaw || punkIdRaw === undefined) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const punkContract = ethers.getAddress(punkContractRaw.toLowerCase());
  const punkId = BigInt(punkIdRaw);
  const account = accountRaw ? ethers.getAddress(accountRaw.toLowerCase()) : null;
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const punk = new ethers.Contract(punkContract, PUNK_ABI, provider);
  const proofEntry = proofEntryFor(proofFile, punkContract);

  const [blockNumberRaw, observationBlocks, deposit, devoured, currentPunkOwner] = await Promise.all([
    provider.getBlockNumber(),
    game.CRYPTOPUNK_OBSERVATION_BLOCKS(),
    game.cryptoPunkDeposits(punkContract, punkId),
    game.devouredExternal(punkContract, punkId),
    optionalCall(null, () => punk.punkIndexToAddress(punkId)),
  ]);

  const blockNumber = BigInt(blockNumberRaw);
  const observed = deposit.owner !== ethers.ZeroAddress;
  const expiresAt = observed ? BigInt(deposit.blockNumber) + observationBlocks : null;
  const expired = expiresAt === null ? false : blockNumber > expiresAt;
  const blocksUntilExpiry = expiresAt && expiresAt > blockNumber ? expiresAt - blockNumber : 0n;
  const lockedInGame = currentPunkOwner && currentPunkOwner.toLowerCase() === gameAddress.toLowerCase();
  const accountOwnsPunk = account ? currentPunkOwner && currentPunkOwner.toLowerCase() === account.toLowerCase() : null;
  const observedByAccount = account ? deposit.owner.toLowerCase() === account.toLowerCase() : null;

  console.log(
    JSON.stringify(
      {
        gameAddress,
        punkContract,
        punkId: punkId.toString(),
        blockNumber: blockNumber.toString(),
        currentPunkOwner,
        lockedInGame,
        devoured,
        proofEntry,
        observation: {
          observed,
          owner: deposit.owner,
          blockNumber: deposit.blockNumber.toString(),
          tier: deposit.tier.toString(),
          codehash: deposit.codehash,
          expiresAt: expiresAt === null ? null : expiresAt.toString(),
          expired,
          blocksUntilExpiry: blocksUntilExpiry.toString(),
        },
        account: account
          ? {
              address: account,
              ownsPunk: accountOwnsPunk,
              observedByAccount,
            }
          : null,
        canDevourCryptoPunkNow:
          !devoured &&
          observed &&
          !expired &&
          lockedInGame &&
          (!account || observedByAccount),
        suggestedAction: devoured
          ? "already devoured"
          : !proofEntry
            ? "collection not found in proof file"
            : !observed
              ? "call observeCryptoPunk with tier and proof"
              : expired
                ? "observation expired; observe again"
                : !lockedInGame
                  ? account && accountOwnsPunk
                    ? "transfer Punk into game contract, then call devourCryptoPunk"
                    : "Punk is not locked in game contract"
                  : account && !observedByAccount
                    ? "observation belongs to another account"
                    : "call devourCryptoPunk",
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
