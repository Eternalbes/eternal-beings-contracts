const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { loadBuild } = require("./deployment-build");
const { HISTORY, ARB_SYS, attestBlockHistory } = require("./stock-world-block-history");

const CONFIRMATION = "TEST-STOCK-WORLD-DELAYED-LOTTERY-46630";
const stringify = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
const DEPLOYMENT_ARTIFACTS = ["MockV4PoolManager", "MockV4Permit2", "MockV4PositionManager", "MockQuoteAsset",
  "StockWorldHookDeployer", "StockWorldHook", "StockWorldGraduationGuard", "StockWorldLiquidityLocker",
  "StockWorldGraduationCoordinator", "QuoteAssetRegistry", "StockWorldConfigValidator", "StockWorldCoreDeployer",
  "StockWorldRenderer", "StockWorldNftDeployer", "StockWorldLaunchDeployer", "StockWorldFactory"];

async function rejectCustom(method, parameters, expected) {
  let error;
  try { await method.staticCall(...parameters); } catch (caught) { error = caught; }
  assert.equal(error?.code, "CALL_EXCEPTION", "transport failure is not a passing revert test");
  assert.equal(error.revert?.name, expected);
}

async function exerciseLottery({ provider, mint, nft, wallets, privateState, savePrivate, report, checkpoint, send, waitBlock }) {
  assert.equal(await mint.epochCapacity(), 1n);
  assert.equal(await mint.walletLimit(), 1n);
  assert.equal(await mint.commitBlocks(), 300n);
  assert.equal(await mint.revealBlocks(), 300n);
  assert.equal(await mint.claimBlocks(), 1200n);
  if (privateState.epoch === undefined) {
    let epoch = await mint.currentEpoch();
    let start = await mint.epochStart(epoch);
    if (await mint.protocolBlockNumber() + 250n >= start + 300n) {
      epoch += 1n;
      start = await mint.epochStart(epoch);
      await waitBlock(start);
    }
    privateState.epoch = epoch.toString();
    privateState.secrets = wallets.map(() => ethers.hexlify(ethers.randomBytes(32)));
    savePrivate();
  }
  const epoch = BigInt(privateState.epoch);
  report.epoch = epoch;
  const start = await mint.epochStart(epoch);
  const target = await mint.entropyBlock(epoch);
  report.entropyBlock = target;
  checkpoint();
  for (let i = 0; i < wallets.length; i++) {
    const participant = mint.connect(wallets[i]);
    const commitment = await mint.computeCommitment(wallets[i].address, epoch, privateState.secrets[i]);
    await send(`mint:commit:${i}`, wallets[i], participant.commitMint, [commitment]);
  }
  await waitBlock(start + 300n);
  for (let i = 0; i < wallets.length; i++) {
    await send(`mint:reveal:${i}`, wallets[i], mint.connect(wallets[i]).revealMint, [epoch, privateState.secrets[i]]);
  }
  assert.equal((await mint.epochState(epoch)).revealedCount, 3n);
  await waitBlock(target + 600n);
  const current = await mint.protocolBlockNumber();
  assert(current > target + 256n && current <= target + 1200n, "must be beyond old history but inside Claim window");
  const block = await provider.getBlock(Number(target));
  assert(block?.hash, "target block header required");
  const historyHash = await provider.call({ to: HISTORY, data: ethers.zeroPadValue(ethers.toBeHex(target), 32) });
  assert.equal(historyHash, block.hash, "native historical hash must match the original RPC header");
  const arbSys = new ethers.Contract(ARB_SYS, ["function arbBlockHash(uint256) view returns(bytes32)"], provider);
  await assert.rejects(() => arbSys.arbBlockHash(target), (error) => error.code === "CALL_EXCEPTION");
  const state = await mint.epochState(epoch);
  const seed = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "bytes32"], [state.revealEntropy, epoch, await mint.getAddress(), historyHash],
  ));
  const winner = Number(BigInt(seed) % 3n);
  for (let i = 0; i < wallets.length; i++) {
    if (i !== winner) await rejectCustom(mint.connect(wallets[i]).claimMint, [epoch], "NotWinner");
  }
  const previousClaim = report.transactions.find((item) => item.label === "mint:delayed-claim");
  if (!previousClaim) assert.equal(state.finalized, false, "no separate Finalize or keeper before delayed Claim");
  const receipt = await send("mint:delayed-claim", wallets[winner], mint.connect(wallets[winner]).claimMint, [epoch]);
  const claimed = receipt.logs.map((log) => {
    try { return mint.interface.parseLog(log); } catch (_) { return null; }
  }).find((log) => log?.name === "NFTClaimed");
  assert(claimed, "missing NFTClaimed event");
  const settled = await mint.epochState(epoch);
  assert.equal(settled.finalized, true);
  assert.equal(settled.usedLateEntropy, false);
  assert.equal(settled.finalSeed, seed);
  assert.equal(settled.winnerCount, 1n);
  assert.equal(await mint.totalMinted(), 1n);
  assert.equal(await nft.totalMinted(), 1n);
  assert.equal(await mint.totalReserved(), 0n);
  assert.equal(await nft.ownerOf(claimed.args.tokenId), wallets[winner].address);
  await rejectCustom(mint.connect(wallets[winner]).claimMint, [epoch], "AlreadyClaimed");
  report.result = { participants: wallets.map((w) => w.address), winner: wallets[winner].address,
    tokenId: claimed.args.tokenId, targetHash: historyHash, finalSeed: seed,
    claimBlock: receipt.blockNumber, delayBlocks: BigInt(receipt.blockNumber) - target,
    oldHistoryExpired: true, winners: 1, usedFallbackEntropy: false };
  assert(report.result.delayBlocks > 256n);
  report.checks = ["three-revealers-one-slot", "no-keeper-before-claim", "old-history-expired",
    "original-header-hash-matches", "identical-selection-seed", "losers-rejected", "one-nft-only",
    "no-reservation-leak", "duplicate-claim-rejected"];
  checkpoint();
}

async function main() {
  const args = { config: "config/stock-world.testnet.json", secret: "reports/secrets/deployer.secrets.json",
    deployment: "reports/deployment-stock-world-testnet-history-v7.json",
    output: "reports/deployment-stock-world-testnet-history-v7-lottery.json",
    mintSecret: "reports/secrets/stock-world-history-v7-lottery.json", budget: "0.0008", broadcast: false, confirm: "" };
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--broadcast") args.broadcast = true;
    else if (["--config", "--secret", "--deployment", "--output", "--mint-secret", "--budget", "--confirm"].includes(flag)) {
      args[flag === "--mint-secret" ? "mintSecret" : flag.slice(2)] = process.argv[++i];
    } else throw new Error(`unknown argument: ${flag}`);
  }
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(args.deployment, "utf8"));
  assert.equal(Number(config.chainId), 46630);
  assert.equal(Number(deployment.chainId), 46630);
  assert.equal(deployment.schemaVersion, 2);
  assert.equal(deployment.status, "deployed-and-smoke-tested");
  const boundBuild = loadBuild(DEPLOYMENT_ARTIFACTS);
  assert.equal(deployment.buildId, boundBuild.buildId, "deployment build mismatch");
  const spendLimit = ethers.parseEther(args.budget);
  assert(spendLimit > 0n && spendLimit <= ethers.parseEther("0.002"));
  if (!args.broadcast) {
    console.log(stringify({ status: "plan-only", chainId: 46630, factory: deployment.contracts.factory.address,
      mintSchedule: { commit: 300, reveal: 300, claim: 1200, slots: 1, participants: 3 },
      launchFeeTestETH: "0.0003", fundingTestETHPerNewWallet: "0.00001", maximumSpendTestETH: args.budget,
      delayBlocks: 600, approvals: "none", burns: false, confirmation: CONFIRMATION }));
    return;
  }
  assert.equal(args.confirm, CONFIRMATION);
  for (const file of [args.secret, args.output, args.mintSecret]) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", file]).status, 0, "private reports must be ignored");
  }
  const build = loadBuild(["StockWorldFactory", "FairMintController", "WorldNFT"]);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const report = fs.existsSync(args.output) ? JSON.parse(fs.readFileSync(args.output, "utf8")) : {
    status: "running", chainId: 46630, factory: deployment.contracts.factory.address,
    buildId: deployment.buildId, transactions: [], maximumCostWei: "0", startedAt: new Date().toISOString() };
  assert.equal(report.factory, deployment.contracts.factory.address);
  assert.equal(report.buildId, deployment.buildId);
  const checkpoint = () => {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${stringify(report)}\n`, { mode: 0o600 });
  };
  try {
    assert.equal((await provider.getNetwork()).chainId, 46630n);
    await attestBlockHistory(provider, await provider.getBlockNumber());
    if (report.status === "passed") {
      const mint = new ethers.Contract(report.world.fairMintController, build.artifacts.FairMintController.abi, provider);
      const nft = new ethers.Contract(report.world.worldNft, build.artifacts.WorldNFT.abi, provider);
      assert.equal((await mint.epochState(report.epoch)).finalSeed, report.result.finalSeed);
      assert.equal(await mint.totalMinted(), 1n);
      assert.equal(await nft.ownerOf(report.result.tokenId), report.result.winner);
      console.log(stringify({ status: "already-passed", report: args.output, result: report.result }));
      return;
    }
    const entry = JSON.parse(fs.readFileSync(args.secret, "utf8")).wallets.find(
      (w) => w.address.toLowerCase() === config.deployer.toLowerCase(),
    );
    assert(entry?.privateKey, "local signer unavailable");
    const primary = new ethers.Wallet(entry.privateKey, provider);
    assert.equal(primary.address.toLowerCase(), config.deployer.toLowerCase());
    let privateState;
    if (fs.existsSync(args.mintSecret)) privateState = JSON.parse(fs.readFileSync(args.mintSecret, "utf8"));
    else {
      assert.equal(report.transactions.length, 0, "cannot resume without local secrets");
      privateState = { factory: report.factory, chainId: 46630,
        wallets: [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()].map((w) => ({ address: w.address, privateKey: w.privateKey })) };
    }
    assert.equal(privateState.factory, report.factory);
    assert.equal(privateState.chainId, 46630);
    const savePrivate = () => {
      fs.mkdirSync(path.dirname(args.mintSecret), { recursive: true });
      fs.writeFileSync(args.mintSecret, `${stringify(privateState)}\n`, { mode: 0o600 });
    };
    savePrivate();
    const wallets = [primary, ...privateState.wallets.map((w) => {
      const wallet = new ethers.Wallet(w.privateKey, provider);
      assert.equal(wallet.address, w.address);
      return wallet;
    })];
    assert.equal(wallets.length, 3);
    const contract = (name, address) => new ethers.Contract(address, build.artifacts[name].abi, primary);
    const factory = contract("StockWorldFactory", report.factory);
    assert.equal(await factory.platformFeeRecipient(), primary.address, "launch fee must return to the approved test wallet");
    if (report.balanceBefore === undefined) report.balanceBefore = (await provider.getBalance(primary.address)).toString();
    assert(await provider.getBalance(primary.address) >= spendLimit);

    // Record the signed transaction hash before broadcast, so an RPC timeout never triggers a duplicate write.
    async function send(label, wallet, method, parameters = [], value = 0n) {
      report.stage = label;
      const request = method ? await method.populateTransaction(...parameters, { value }) : { to: parameters[0], value };
      let item = report.transactions.find((tx) => tx.label === label);
      const dataHash = ethers.keccak256(request.data || "0x");
      if (item) {
        assert.equal(item.from, wallet.address);
        assert.equal(item.to.toLowerCase(), request.to.toLowerCase());
        assert.equal(item.dataHash, dataHash);
        assert.equal(BigInt(item.value), value);
      } else {
        const fee = await provider.getFeeData();
        assert(fee.maxFeePerGas && fee.maxPriorityFeePerGas !== null);
        const gasLimit = await provider.estimateGas({ ...request, from: wallet.address }) * 125n / 100n;
        const cost = value + gasLimit * fee.maxFeePerGas;
        assert(BigInt(report.maximumCostWei) + cost <= spendLimit, "test budget exceeded");
        const nonce = await provider.getTransactionCount(wallet.address, "pending");
        const raw = await wallet.signTransaction({ ...request, nonce, chainId: 46630, type: 2, gasLimit,
          maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
        item = { label, hash: ethers.keccak256(raw), from: wallet.address, to: request.to,
          dataHash, value: value.toString(), nonce, status: "prepared" };
        report.transactions.push(item);
        report.maximumCostWei = (BigInt(report.maximumCostWei) + cost).toString();
        checkpoint();
        try { await provider.broadcastTransaction(raw); item.status = "pending"; checkpoint(); }
        catch (_) { item.status = "broadcast-uncertain"; checkpoint(); }
      }
      const receipt = await provider.waitForTransaction(item.hash, 1, 120_000);
      assert(receipt?.status === 1, "transaction missing or reverted; inspect recorded hash before retrying");
      assert.equal(receipt.from.toLowerCase(), wallet.address.toLowerCase());
      assert.equal(receipt.to.toLowerCase(), request.to.toLowerCase());
      Object.assign(item, { status: "mined", blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
      checkpoint();
      console.log(`${label}: confirmed ${receipt.hash}`);
      return receipt;
    }
    const imageHash = ethers.id("stock-world-history-lottery-image");
    const configuration = ["Delayed Claim History Test", "DCH", ethers.ZeroAddress, primary.address,
      ethers.parseEther("4.2"), 100, 4500, 4500, 1000, [3, [300, 300, 1200, 1, 1]],
      [imageHash, ethers.id("history-lottery-vector"), ethers.id("history-lottery-palette"),
        ethers.id("history-lottery-style"), `seed://${imageHash.slice(2)}`, 1]];
    const receipt = await send("launch:lotteryWorld", primary, factory.launchWorld, [configuration], ethers.parseEther("0.0003"));
    const launched = receipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch (_) { return null; } })
      .find((log) => log?.name === "WorldLaunched");
    assert(launched, "missing WorldLaunched event");
    report.worldId = launched.args.worldId;
    const world = await factory.getWorld(report.worldId);
    assert.equal(world.creator, primary.address);
    assert.equal(world.quoteAsset, ethers.ZeroAddress);
    report.world = { worldNft: world.worldNft, fairMintController: world.fairMintController, worldToken: world.worldToken };
    const mint = contract("FairMintController", world.fairMintController);
    const nft = contract("WorldNFT", world.worldNft);
    assert.equal(await nft.mintController(), world.fairMintController);
    for (let i = 1; i < wallets.length; i++) {
      await send(`fund:participant:${i}`, primary, null, [wallets[i].address], ethers.parseEther("0.00001"));
    }
    const waitBlock = async (target) => {
      const deadline = Date.now() + 180_000;
      while (await mint.protocolBlockNumber() < target) {
        assert(Date.now() < deadline, "protocol clock did not advance");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    await exerciseLottery({ provider, mint, nft, wallets, privateState, savePrivate, report, checkpoint, send, waitBlock });
    report.netPrimaryTestETHSpent = ethers.formatEther(BigInt(report.balanceBefore) - await provider.getBalance(primary.address));
    report.status = "passed";
    report.completedAt = new Date().toISOString();
    checkpoint();
    console.log(stringify({ status: report.status, report: args.output, worldId: report.worldId,
      result: report.result, checks: report.checks, netPrimaryTestETHSpent: report.netPrimaryTestETHSpent }));
  } catch (error) {
    report.status = "needs-review";
    report.failure = { code: error.code || "TEST_FAILED", stage: report.stage || "preflight" };
    checkpoint();
    throw error;
  } finally { provider.destroy(); }
}

module.exports = { exerciseLottery };
if (require.main === module) main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
