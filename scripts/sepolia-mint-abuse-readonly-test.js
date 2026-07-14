const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-clean-2-wallet-mint-cycle.json",
  outputPath = "reports/sepolia-mint-abuse-readonly-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-mint-abuse-readonly-test.js <rpcUrl> <gameAddress> [claimReport] [outputPath]",
      "",
      "Runs eth_call-only mint abuse checks. It does not submit transactions or require private keys.",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function expectReject(label, fn) {
  try {
    const value = await fn();
    return { label, ok: false, unexpectedValue: String(value) };
  } catch (error) {
    return { label, ok: true, error: error.shortMessage || error.reason || error.message };
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function phase(provider, game) {
  const [blockRaw, currentEpoch, commitBlocks, epochBlocks] = await Promise.all([
    provider.getBlockNumber(),
    game.currentEpoch(),
    game.COMMIT_BLOCKS(),
    game.EPOCH_BLOCKS(),
  ]);
  const block = BigInt(blockRaw);
  const start = await game.epochStart(currentEpoch);
  return {
    block,
    currentEpoch,
    start,
    inCommit: block >= start && block < start + commitBlocks,
    inReveal: block >= start + commitBlocks && block < start + epochBlocks,
  };
}

async function waitFor(provider, game, predicate, label) {
  for (;;) {
    const current = await phase(provider, game);
    if (predicate(current)) return current;
    console.log(JSON.stringify({ step: "wait", label, blockNumber: current.block.toString(), epoch: current.currentEpoch.toString() }));
    await sleep(2500);
  }
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = readJson("artifacts/EternalBeings.json");
  const game = new ethers.Contract(gameAddress, artifact.abi, provider);
  const claimReport = readJson(claimReportPath);
  const mintedClaim = (claimReport.claims || []).find((claim) => claim.ok && claim.tokenId);
  if (!mintedClaim) throw new Error("claim report has no minted claim");

  const minted = new ethers.VoidSigner(mintedClaim.address, provider);
  const fresh = new ethers.VoidSigner(ethers.Wallet.createRandom().address, provider);
  const fakeSecret = ethers.keccak256(ethers.toUtf8Bytes("wrong-secret"));
  const fakeCommitment = ethers.keccak256(ethers.toUtf8Bytes("fake-commitment"));

  const mintedGame = game.connect(minted);
  const freshGame = game.connect(fresh);
  const mintedEpoch = BigInt(claimReport.epoch || 0);
  const mintedClaimed = await game.claimedEpoch(mintedEpoch, mintedClaim.address);
  const mintedRevealed = await game.revealed(mintedEpoch, mintedClaim.address);
  const mintedFlag = await game.hasMintedBeing(mintedClaim.address);

  const commitPhase = await waitFor(provider, game, (current) => current.inCommit, "commit");
  const commitRejected = [
    await expectReject("minted address cannot commit again", () => mintedGame.commitMint.staticCall(fakeCommitment)),
    await expectReject("zero commitment rejected", () => freshGame.commitMint.staticCall(ethers.ZeroHash)),
  ];
  const revealPhase = await waitFor(provider, game, (current) => current.currentEpoch === commitPhase.currentEpoch && current.inReveal, "reveal");
  const rejected = [
    ...commitRejected,
    await expectReject("minted address cannot reveal current epoch", () => mintedGame.revealMint.staticCall(revealPhase.currentEpoch, fakeSecret)),
    await expectReject("minted address cannot claim previous epoch again", () => mintedGame.claimMint.staticCall(mintedEpoch)),
    await expectReject("fresh address cannot claim without reveal", () => freshGame.claimMint.staticCall(revealPhase.currentEpoch)),
    await expectReject("fresh address cannot reveal without matching commit", () => freshGame.revealMint.staticCall(revealPhase.currentEpoch, fakeSecret)),
  ];

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    blockNumber: await provider.getBlockNumber(),
    currentEpoch: revealPhase.currentEpoch.toString(),
    checkedCommitBlock: commitPhase.block.toString(),
    checkedRevealBlock: revealPhase.block.toString(),
    mintedAddress: mintedClaim.address,
    mintedEpoch: mintedEpoch.toString(),
    mintedState: {
      hasMintedBeing: mintedFlag,
      revealedInMintEpoch: mintedRevealed,
      claimedInMintEpoch: mintedClaimed,
    },
    rejected,
    ok: mintedFlag && mintedRevealed && mintedClaimed && rejected.every((item) => item.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
