const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/mint-commitment.js <userAddress> <epoch> <secret>",
      "",
      "Output secretHash is the bytes32 value to pass to revealMint(epoch, secretHash).",
      "Keep the original secret private until reveal.",
    ].join("\n"),
  );
}

function main() {
  const [userAddress, epochRaw, secret] = process.argv.slice(2);
  if (!userAddress || epochRaw === undefined || !secret) {
    usage();
    process.exit(1);
  }

  const normalizedUser = ethers.getAddress(userAddress.toLowerCase());
  const epoch = BigInt(epochRaw);
  const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
  const commitment = ethers.solidityPackedKeccak256(["address", "uint256", "bytes32"], [normalizedUser, epoch, secretHash]);

  console.log(
    JSON.stringify(
      {
        userAddress: normalizedUser,
        epoch: epoch.toString(),
        secretHash,
        commitment,
        commitCall: `commitMint(${commitment})`,
        revealCall: `revealMint(${epoch.toString()}, ${secretHash})`,
      },
      null,
      2,
    ),
  );
}

main();
