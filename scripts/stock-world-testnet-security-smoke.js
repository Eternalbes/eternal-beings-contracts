const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { loadBuild } = require("./deployment-build");

const CONFIRMATION = "TEST-STOCK-WORLD-SECURITY-46630";
const stringify = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);

async function main() {
  const args = { config: "config/stock-world.testnet.json", secret: "reports/secrets/deployer.secrets.json",
    deployment: "reports/deployment-stock-world-testnet-security-v6.json",
    output: "reports/deployment-stock-world-testnet-security-v6-smoke.json",
    mintSecret: "reports/secrets/stock-world-security-v6-mint.json", budget: "0.001", broadcast: false, confirm: "" };
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--broadcast") args.broadcast = true;
    else if (["--config", "--secret", "--deployment", "--output", "--mint-secret", "--budget", "--confirm"].includes(flag)) {
      const key = flag === "--mint-secret" ? "mintSecret" : flag.slice(2);
      args[key] = process.argv[++i];
    } else throw new Error(`unknown argument: ${flag}`);
  }
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(args.deployment, "utf8"));
  assert.equal(Number(config.chainId), 46630, "testnet only");
  assert.equal(Number(deployment.chainId), 46630, "deployment must be on testnet");
  assert.equal(deployment.schemaVersion, 2, "requires build-bound deployment report");
  assert.equal(deployment.status, "deployed-and-smoke-tested");
  assert(deployment.smokeWorld, "deployment must contain a smoke World");
  const spendLimit = ethers.parseEther(args.budget);
  assert(spendLimit > 0n && spendLimit <= ethers.parseEther("0.02"), "test budget must be above zero and at most 0.02 test ETH");
  if (!args.broadcast) {
    console.log(stringify({ status: "plan-only", chainId: 46630,
      factory: deployment.contracts.factory.address, worldId: deployment.smokeWorld.worldId,
      buyTestETH: "0.000001", maximumTestETHSpend: args.budget, approvals: "exact amounts only", burns: false,
      actions: ["commit", "reveal", "claim", "buy", "stake", "sell 25%", "claim rewards", "withdraw stake"],
      confirmation: CONFIRMATION }));
    return;
  }
  assert.equal(args.confirm, CONFIRMATION, "explicit test confirmation required");
  for (const file of [args.secret, args.output, args.mintSecret]) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", file]).status, 0, "secrets and reports must be ignored");
  }
  assert(!fs.existsSync(args.output), "existing test report: inspect before rerunning, use new output path");
  assert(!fs.existsSync(args.mintSecret), "existing Mint secret: preserve it; use a new secret path");
  const build = loadBuild(["StockWorldFactory", "FairMintController", "WorldNFT", "WorldToken",
    "StockWorldBondingCurve", "TokenRewardVault", "WorldRewardVault"]);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const report = { status: "running", chainId: 46630, factory: deployment.contracts.factory.address,
    worldId: deployment.smokeWorld.worldId, transactions: [], checks: [], startedAt: new Date().toISOString() };
  const checkpoint = () => {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${stringify(report)}\n`, { mode: 0o600 });
  };
  try {
    assert.equal((await provider.getNetwork()).chainId, 46630n);
    const secretData = JSON.parse(fs.readFileSync(args.secret, "utf8"));
    const entry = secretData.wallets.find((w) => w.address.toLowerCase() === config.deployer.toLowerCase());
    assert(entry?.privateKey, "local signer unavailable");
    const wallet = new ethers.Wallet(entry.privateKey, provider);
    assert.equal(wallet.address.toLowerCase(), config.deployer.toLowerCase());
    const signer = new ethers.NonceManager(wallet);
    const contract = (name, address) => new ethers.Contract(address, build.artifacts[name].abi, signer);
    const factory = contract("StockWorldFactory", report.factory);
    const world = await factory.getWorld(report.worldId);
    assert.equal(world.creator.toLowerCase(), wallet.address.toLowerCase());
    assert.equal(world.quoteAsset, ethers.ZeroAddress, "native ETH test only");
    assert.equal(world.fairMintController.toLowerCase(), deployment.smokeWorld.fairMintController.toLowerCase());
    const mint = contract("FairMintController", world.fairMintController);
    const nft = contract("WorldNFT", world.worldNft);
    const token = contract("WorldToken", world.worldToken);
    const curve = contract("StockWorldBondingCurve", world.bondingCurve);
    const tokenVault = contract("TokenRewardVault", world.tokenRewardVault);
    const nftVault = contract("WorldRewardVault", world.worldRewardVault);
    assert.equal(await nft.mintController(), world.fairMintController);
    assert.equal(await mint.worldNft(), world.worldNft);
    assert.equal(await tokenVault.worldToken(), world.worldToken);
    assert.equal(await nft.rewardVault(), world.worldRewardVault);
    assert.equal(await token.totalSupply(), ethers.parseEther("1000000000"));
    assert.equal(await mint.totalMinted(), 0n, "requires an untouched test World");
    assert.equal(await tokenVault.rewardRemainder(wallet.address), 0n);
    assert.equal(await nftVault.rewardRemainder(wallet.address), 0n);
    const balanceBefore = await provider.getBalance(wallet.address);
    assert(balanceBefore >= spendLimit, "insufficient balance for test budget");
    report.world = { worldToken: world.worldToken, worldNft: world.worldNft,
      fairMintController: world.fairMintController, bondingCurve: world.bondingCurve,
      tokenRewardVault: world.tokenRewardVault, worldRewardVault: world.worldRewardVault };
    let committedBudget = 0n;
    async function send(label, method, parameters = [], value = 0n) {
      report.stage = label; checkpoint();
      const gasEstimate = await method.estimateGas(...parameters, { value });
      const gasLimit = gasEstimate * 125n / 100n;
      const fee = await provider.getFeeData();
      assert(fee.maxFeePerGas && fee.maxPriorityFeePerGas !== null, "EIP-1559 fee estimate required");
      const maximumCost = value + gasLimit * fee.maxFeePerGas;
      assert(committedBudget + maximumCost <= spendLimit, "test transaction budget exceeded");
      const transaction = await method(...parameters, { value, gasLimit,
        maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
      committedBudget += maximumCost;
      const item = { label, hash: transaction.hash, status: "pending" };
      report.transactions.push(item); checkpoint();
      const receipt = await provider.waitForTransaction(transaction.hash, 1, 120_000);
      assert(receipt && receipt.status === 1, `${label} failed or timed out`);
      Object.assign(item, { status: "mined", blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
      checkpoint();
      console.log(`${label}: confirmed ${receipt.hash}`);
      return receipt;
    }
    async function rejectCustom(method, parameters, expected, label) {
      let error;
      try { await method.staticCall(...parameters); } catch (caught) { error = caught; }
      assert(error, `${label}: expected a revert`);
      assert.equal(error.code, "CALL_EXCEPTION", `${label}: RPC failure is not a passing test`);
      assert.equal(error.revert?.name, expected, `${label}: wrong custom error`);
      report.checks.push(label); checkpoint();
    }
    async function waitBlock(target) {
      const timeout = Date.now() + 180_000;
      while (await mint.protocolBlockNumber() < target) {
        assert(Date.now() < timeout, "timed out waiting for protocol block");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    await rejectCustom(nft.mintFromController, [wallet.address, ethers.ZeroHash],
      "NotMintController", "direct-mint-bypass-rejected");
    await rejectCustom(nft.setMintController, [wallet.address], "NotFactory", "mint-controller-replacement-rejected");
    await rejectCustom(nftVault.checkpointNftWeight, [1, wallet.address, 999999],
      "NotNftController", "forged-nft-reward-weight-rejected");
    const commitBlocks = await mint.commitBlocks();
    const revealBlocks = await mint.revealBlocks();
    assert(commitBlocks >= 300n && commitBlocks <= 600n && revealBlocks >= 300n && revealBlocks <= 600n,
      "requires a fast test schedule");
    let epoch = await mint.currentEpoch();
    let epochStart = await mint.epochStart(epoch);
    if (await mint.protocolBlockNumber() + 150n >= epochStart + commitBlocks) {
      epoch += 1n; epochStart = await mint.epochStart(epoch);
      await waitBlock(epochStart);
    }
    const mintSecret = ethers.hexlify(ethers.randomBytes(32));
    const commitment = await mint.computeCommitment(wallet.address, epoch, mintSecret);
    fs.mkdirSync(path.dirname(args.mintSecret), { recursive: true });
    fs.writeFileSync(args.mintSecret, stringify({ chainId: 46630, controller: world.fairMintController,
      wallet: wallet.address, epoch, secret: mintSecret, commitment }), { mode: 0o600, flag: "wx" });
    report.epoch = epoch;
    await send("mint:commit", mint.commitMint, [commitment]);
    await rejectCustom(mint.commitMint, [commitment], "AlreadyCommitted", "duplicate-commit-rejected");
    await waitBlock(epochStart + commitBlocks);
    await rejectCustom(mint.revealMint, [epoch, ethers.ZeroHash], "InvalidSecret", "wrong-secret-rejected");
    await send("mint:reveal", mint.revealMint, [epoch, mintSecret]);
    await waitBlock(await mint.entropyBlock(epoch) + 1n);
    const mintReceipt = await send("mint:claim", mint.claimMint, [epoch]);
    const event = mintReceipt.logs.map((log) => { try { return mint.interface.parseLog(log); } catch (_) { return null; } })
      .find((log) => log?.name === "NFTClaimed");
    assert(event, "missing NFTClaimed event");
    const tokenId = event.args.tokenId;
    report.tokenId = tokenId;
    assert.equal(await nft.ownerOf(tokenId), wallet.address);
    assert.equal(await mint.totalReserved(), 0n);
    assert.equal(await mint.totalMinted(), 1n);
    assert.equal(await nft.totalMinted(), 1n);
    assert.equal((await mint.epochState(epoch)).finalized, true);
    await rejectCustom(mint.claimMint, [epoch], "AlreadyClaimed", "duplicate-mint-claim-rejected");
    const uri = await nft.tokenURI(tokenId);
    assert(uri.startsWith("data:application/json;base64,"));
    const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    assert(metadata.image.startsWith("data:image/svg+xml;base64,"));
    const svg = Buffer.from(metadata.image.split(",")[1], "base64").toString("utf8");
    assert(svg.includes("<svg") && svg.endsWith("</svg>"));
    report.checks.push("three-step-mint-without-finalize-transaction", "on-chain-json-and-svg-decode");

    const quoteIn = ethers.parseEther("0.000001");
    const preview = await curve.previewBuy(quoteIn);
    assert.equal(preview.refund, 0n);
    const oldTokens = await token.balanceOf(wallet.address);
    const deadline = async () => BigInt((await provider.getBlock("latest")).timestamp + 600);
    await send("trade:buy", curve.buy, [quoteIn, preview.tokensOut * 9900n / 10000n, wallet.address, await deadline()], quoteIn);
    const bought = await token.balanceOf(wallet.address) - oldTokens;
    assert.equal(bought, preview.tokensOut);
    const stake = bought / 4n;
    assert(stake > 0n);
    await send("stake:approve-exact", token.approve, [world.tokenRewardVault, stake]);
    await send("stake:queue", tokenVault.queueStake, [stake]);
    assert.equal(await token.allowance(wallet.address, world.tokenRewardVault), 0n);
    await waitBlock((await tokenVault.positionOf(wallet.address)).activationBlock);
    await send("stake:activate", tokenVault.activateStake);
    assert.equal(await tokenVault.pendingRewards(wallet.address), 0n, "new stake cannot earn earlier buy fees");
    const sale = bought / 4n;
    await send("trade:approve-exact", token.approve, [world.bondingCurve, sale]);
    const sellPreview = await curve.previewSell(sale);
    await send("trade:sell", curve.sell, [sale, sellPreview.quoteOut * 9900n / 10000n, wallet.address, await deadline()]);
    assert.equal(await token.allowance(wallet.address, world.bondingCurve), 0n);
    assert.equal(await token.balanceOf(wallet.address), oldTokens + bought - stake - sale);
    assert(await tokenVault.pendingRewards(wallet.address) > 0n, "active stake receives new trade fees");
    assert(await tokenVault.pendingRewards(wallet.address) <= await provider.getBalance(world.tokenRewardVault),
      "token rewards must be funded");
    await send("reward:token-claim", tokenVault.claim, [wallet.address]);
    await rejectCustom(tokenVault.claim, [wallet.address], "NothingToClaim", "duplicate-token-reward-rejected");
    await send("reward:nft-settle", nft.settleReward, [tokenId]);
    assert(await nftVault.nftClaimable(wallet.address) > 0n);
    assert(await nftVault.nftClaimable(wallet.address) + await nftVault.creatorClaimable()
      <= await provider.getBalance(world.worldRewardVault), "NFT and creator rewards must be funded");
    await send("reward:nft-claim", nftVault.claimNftReward, [wallet.address]);
    await rejectCustom(nftVault.claimNftReward, [wallet.address], "NothingToClaim", "duplicate-nft-reward-rejected");
    assert(await nftVault.creatorClaimable() > 0n);
    await send("reward:creator-claim", nftVault.claimCreatorReward, [wallet.address]);
    await rejectCustom(nftVault.claimCreatorReward, [wallet.address], "NothingToClaim", "duplicate-creator-reward-rejected");
    await send("stake:withdraw", tokenVault.withdrawStake, [stake, wallet.address]);
    assert.equal((await tokenVault.positionOf(wallet.address)).activeStake, 0n);
    assert.equal(await token.balanceOf(wallet.address), oldTokens + bought - sale);
    assert.equal(await tokenVault.totalActiveStake(), 0n);
    report.checks.push("exact-approvals-consumed", "no-historical-stake-rewards", "stake-principal-returned");
    report.results = { purchasedTokens: ethers.formatEther(bought), soldTokens: ethers.formatEther(sale),
      tokenRewardWei: await tokenVault.totalRewardsClaimed(), nftRewardWei: await nftVault.totalNftRewardsClaimed(),
      creatorRewardWei: await nftVault.totalCreatorRewardsClaimed(),
      netTestETHSpent: ethers.formatEther(balanceBefore - await provider.getBalance(wallet.address)) };
    report.status = "passed"; report.completedAt = new Date().toISOString(); checkpoint();
    console.log(stringify({ status: report.status, report: args.output, tokenId, checks: report.checks, results: report.results }));
  } catch (error) {
    report.status = "failed";
    // Preserve transaction hashes and the separate Mint secret, never error calldata.
    report.failure = { code: error.code || "TEST_FAILED", stage: report.stage || "preflight" };
    checkpoint();
    throw error;
  } finally { provider.destroy(); }
}

main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
