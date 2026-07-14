const fs = require("fs");
const { ethers } = require("ethers");

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
];

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/external-devour-status.js <rpcUrl> <gameAddress> <nftAddress> <externalTokenId> [account]",
      "",
      "Reads unknown external NFT devour readiness: observation, hold blocks, ERC721 support, totalSupply, and devoured flag.",
    ].join("\n"),
  );
}

async function optionalCall(fallback, fn) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function main() {
  const [rpcUrl, gameAddress, nftAddressRaw, tokenIdRaw, accountRaw] = process.argv.slice(2);
  if (!rpcUrl || !gameAddress || !nftAddressRaw || tokenIdRaw === undefined) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const nftAddress = ethers.getAddress(nftAddressRaw.toLowerCase());
  const tokenId = BigInt(tokenIdRaw);
  const account = accountRaw ? ethers.getAddress(accountRaw.toLowerCase()) : null;
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const nft = new ethers.Contract(nftAddress, ERC721_ABI, provider);

  const [
    blockNumberRaw,
    holdBlocks,
    minSupply,
    collectionLimit,
    collectionDevours,
    devoured,
    observation,
    ownerOfToken,
    totalSupply,
    supportsERC721,
  ] = await Promise.all([
    provider.getBlockNumber(),
    game.UNKNOWN_HOLD_BLOCKS(),
    game.UNKNOWN_MIN_TOTAL_SUPPLY(),
    game.UNKNOWN_COLLECTION_DEVOUR_LIMIT(),
    game.unknownCollectionDevours(nftAddress),
    game.devouredExternal(nftAddress, tokenId),
    game.externalObservations(nftAddress, tokenId),
    optionalCall(null, () => nft.ownerOf(tokenId)),
    optionalCall(null, () => nft.totalSupply()),
    optionalCall(false, () => nft.supportsInterface("0x80ac58cd")),
  ]);

  const blockNumber = BigInt(blockNumberRaw);
  const observed = observation.owner !== ethers.ZeroAddress;
  const readyBlock = observed ? BigInt(observation.blockNumber) + holdBlocks : null;
  const holdRemaining = readyBlock && readyBlock > blockNumber ? readyBlock - blockNumber : 0n;
  const supplyOk = totalSupply !== null && totalSupply >= minSupply;
  const collectionCapOk = collectionDevours < collectionLimit;
  const accountOwnsToken = account ? ownerOfToken && ownerOfToken.toLowerCase() === account.toLowerCase() : null;
  const observedByAccount = account ? observation.owner.toLowerCase() === account.toLowerCase() : null;

  console.log(
    JSON.stringify(
      {
        gameAddress,
        nftAddress,
        tokenId: tokenId.toString(),
        blockNumber: blockNumber.toString(),
        ownerOfToken,
        devoured,
        supportsERC721,
        totalSupply: totalSupply === null ? null : totalSupply.toString(),
        minSupply: minSupply.toString(),
        supplyOk,
        collectionDevours: collectionDevours.toString(),
        collectionLimit: collectionLimit.toString(),
        collectionCapOk,
        observation: {
          observed,
          owner: observation.owner,
          blockNumber: observation.blockNumber.toString(),
          readyBlock: readyBlock === null ? null : readyBlock.toString(),
          holdRemaining: holdRemaining.toString(),
          codehash: observation.codehash,
        },
        account: account
          ? {
              address: account,
              ownsToken: accountOwnsToken,
              observedByAccount,
            }
          : null,
        canDevourUnknownNow:
          !devoured &&
          supportsERC721 &&
          supplyOk &&
          collectionCapOk &&
          observed &&
          holdRemaining === 0n &&
          (!account || (accountOwnsToken && observedByAccount)),
        suggestedAction: devoured
          ? "already devoured"
          : !supportsERC721
            ? "not ERC721-compatible"
            : !supplyOk
              ? "totalSupply below UNKNOWN_MIN_TOTAL_SUPPLY"
              : !collectionCapOk
                ? "unknown collection devour cap reached"
                : !observed
                  ? "call observeExternal"
                  : holdRemaining > 0n
                    ? "wait for hold period"
                    : account && !accountOwnsToken
                      ? "account does not own token"
                      : account && !observedByAccount
                        ? "observation belongs to another account"
                        : "approve game and call devourExternal",
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
