const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function artifact(name) {
  return JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
}

async function deploy(name, signer, args = []) {
  const item = artifact(name);
  const factory = new ethers.ContractFactory(item.abi, item.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function rejects(action, message) {
  let failed = false;
  try {
    const result = await action();
    if (result && result.wait) await result.wait();
  } catch (_) {
    failed = true;
  }
  assert(failed, message);
}

async function deadline(provider) {
  const block = await provider.getBlock("latest");
  return BigInt(block.timestamp + 3_600);
}

async function main() {
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", allowUnlimitedContractSize: false },
    miner: { blockGasLimit: 100_000_000 },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [authority, creator, launcher, trader, feeRecipient] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
  );
  const [authorityAddress, creatorAddress, launcherAddress, traderAddress, feeRecipientAddress] =
    await Promise.all(
      [authority, creator, launcher, trader, feeRecipient].map((signer) => signer.getAddress()),
    );

  const quote = await deploy("MockQuoteAsset", authority, ["Mock USD", "mUSD", 6]);
  const registry = await deploy("QuoteAssetRegistry", authority, [authorityAddress]);
  await (await registry.registerQuoteAsset(await quote.getAddress())).wait();
  const validator = await deploy("StockWorldConfigValidator", authority, [await registry.getAddress()]);
  const coordinator = await deploy("MockGraduationCoordinator", authority);
  const coreDeployer = await deploy("StockWorldCoreDeployer", authority);
  const nftDeployer = await deploy("StockWorldNftDeployer", authority);
  const launchDeployer = await deploy("StockWorldLaunchDeployer", authority, [
    await coreDeployer.getAddress(),
    await nftDeployer.getAddress(),
  ]);
  const factory = await deploy("StockWorldFactory", authority, [
    await validator.getAddress(),
    await launchDeployer.getAddress(),
    await coordinator.getAddress(),
    feeRecipientAddress,
    12,
    8,
    40,
  ]);

  const config = {
    name: "A".repeat(64),
    symbol: "SYMBOL123456",
    quoteAsset: await quote.getAddress(),
    creator: creatorAddress,
    graduationTarget: 900_000_000n,
    nftMaxSupply: 100,
    tokenHolderBps: 4_000,
    nftHolderBps: 4_000,
    creatorBps: 2_000,
  };
  const launchFee = ethers.parseEther("0.0003");

  await rejects(
    () => factory.connect(launcher).launchWorld(config, { value: launchFee - 1n }),
    "underpaid launch rejected",
  );
  await rejects(
    () => factory.connect(launcher).launchWorld(config, { value: launchFee + 1n }),
    "overpaid launch rejected rather than retained",
  );
  assert.equal(await factory.worldCount(), 0n, "failed launches create no record");

  const balanceBlock = await provider.getBlockNumber();
  const recipientBalanceBefore = await provider.getBalance(feeRecipientAddress, balanceBlock);
  const launchReceipt = await (
    await factory.connect(launcher).launchWorld(config, { value: launchFee, gasLimit: 70_000_000 })
  ).wait();
  assert.equal(await factory.worldCount(), 1n, "successful launch creates exactly one World");
  assert.equal(
    (await provider.getBalance(feeRecipientAddress, launchReceipt.blockNumber)) - recipientBalanceBefore,
    launchFee,
    "fixed launch fee is forwarded exactly",
  );
  assert.equal(await provider.getBalance(await factory.getAddress()), 0n, "factory retains no launch ETH");

  const world = await factory.getWorld(0);
  const expectedHash = await validator.hashConfig(config);
  assert.equal(world.configHash, expectedHash, "factory records canonical configuration hash");
  assert.equal(world.creator, creatorAddress, "creator is immutable launch input");
  assert.equal(world.phase, 1n, "new World starts on the bonding curve");
  assert.equal(await factory.worldIdOfToken(world.worldToken), 1n, "token reverse lookup uses one-based id");
  assert.equal(await factory.worldIdOfNft(world.worldNft), 1n, "NFT reverse lookup uses one-based id");

  for (const address of [
    world.worldToken,
    world.tokenRewardVault,
    world.worldRewardVault,
    world.bondingCurve,
    world.worldNft,
    world.fairMintController,
    world.graduationEscrow,
  ]) {
    assert.notEqual(await provider.getCode(address), "0x", `module ${address} was deployed`);
  }

  const token = new ethers.Contract(world.worldToken, artifact("WorldToken").abi, provider);
  const rewardVault = new ethers.Contract(world.worldRewardVault, artifact("WorldRewardVault").abi, provider);
  const curve = new ethers.Contract(world.bondingCurve, artifact("StockWorldBondingCurve").abi, provider);
  const nft = new ethers.Contract(world.worldNft, artifact("WorldNFT").abi, provider);
  const mint = new ethers.Contract(world.fairMintController, artifact("FairMintController").abi, provider);
  const escrow = new ethers.Contract(
    world.graduationEscrow,
    artifact("StockWorldGraduationEscrow").abi,
    provider,
  );

  const fixedSupply = ethers.parseEther("1000000");
  assert.equal(await token.balanceOf(world.bondingCurve), fixedSupply, "entire token supply enters curve");
  assert.equal(await token.balanceOf(await factory.getAddress()), 0n, "factory keeps no World tokens");
  assert.equal(await curve.phase(), 1n, "curve was initialized atomically");
  assert.equal(await curve.virtualQuoteReserve(), 100_000_000n, "virtual reserve derives from target");
  assert.equal(await curve.reservedTokens(), ethers.parseEther("100000"), "ten percent reserved for graduation");
  assert.equal(await nft.name(), `${config.name} Beings`, "NFT name is deterministically derived");
  assert.equal(await nft.symbol(), `${config.symbol}-NFT`, "NFT symbol is deterministically derived");
  assert.equal(await nft.mintController(), world.fairMintController, "mint controller bound once");
  assert.equal(await rewardVault.nftController(), world.worldNft, "NFT reward checkpoints bound once");
  assert.equal(
    await rewardVault.liquidityReserveRecipient(),
    world.graduationEscrow,
    "liquidity reserve can only reach per-World escrow",
  );
  assert.equal(await mint.epochCapacity(), 4n, "NFT supply is spread across thirty epochs");
  assert.equal(await mint.walletLimit(), 2n, "fair mint wallet cap is fixed by factory");
  assert.equal(await mint.commitBlocks(), 12n, "factory commit duration applied");
  assert.equal(await mint.revealBlocks(), 8n, "factory reveal duration applied");
  assert.equal(await mint.claimBlocks(), 40n, "factory claim duration applied");

  await rejects(() => factory.getWorld(1), "unknown World id rejected");
  await rejects(() => factory.prepareGraduation(0), "live curve cannot be swept early");
  await rejects(
    () => validator.validateConfig({ ...config, graduationTarget: ethers.MaxUint256 }),
    "overflowing graduation economics rejected during validation",
  );

  await (await quote.mint(traderAddress, 10_000_000_000n)).wait();
  await (await quote.connect(trader).approve(world.bondingCurve, 10_000_000_000n)).wait();
  const finalPreview = await curve.previewBuy(10_000_000_000n);
  await (
    await curve
      .connect(trader)
      .buy(10_000_000_000n, finalPreview.tokensOut, traderAddress, await deadline(provider))
  ).wait();
  assert.equal(await curve.phase(), 2n, "terminal partial fill makes World graduation-ready");

  await (await coordinator.setPreflightAllowed(false)).wait();
  await rejects(() => factory.prepareGraduation(0), "failed preflight leaves reserves on curve");
  assert.equal(await curve.phase(), 2n, "failed preflight does not sweep curve");
  assert.equal((await factory.getWorld(0)).phase, 1n, "failed preflight does not advance World phase");

  await (await coordinator.setPreflightAllowed(true)).wait();
  assert.equal(await coordinator.preflightAllowed(), true, "preflight mock was re-enabled");
  const expectedCurveQuote = await curve.trackedQuoteReserve();
  const expectedCurveTokens = await curve.trackedTokenReserve();
  await (await factory.prepareGraduation(0, { gasLimit: 5_000_000 })).wait();
  const prepared = await factory.getWorld(0);
  assert.equal(prepared.phase, 2n, "successful preflight moves reserves into escrow");
  assert.equal(await curve.phase(), 3n, "curve sweep is complete");
  assert.equal(await escrow.curveSweepRecorded(), true, "escrow records curve transfer exactly once");
  assert.equal(await escrow.trackedTokens(), expectedCurveTokens, "escrow tracks graduation token reserve");
  assert((await escrow.trackedQuote()) >= expectedCurveQuote, "escrow also includes committed fee reserves");

  await (await coordinator.setCompletionAllowed(false)).wait();
  await rejects(() => factory.completeGraduation(0), "failed market creation remains retryable");
  assert.equal(await escrow.releaseArmed(), false, "failed completion rolls back release arming");
  assert.equal(await escrow.released(), false, "failed completion cannot consume reserves");
  assert.equal((await factory.getWorld(0)).phase, 2n, "failed completion preserves prepared phase");

  await (await coordinator.setCompletionAllowed(true)).wait();
  assert.equal(await coordinator.completionAllowed(), true, "completion mock was re-enabled");
  const trackedQuote = await escrow.trackedQuote();
  const trackedTokens = await escrow.trackedTokens();
  const marketId = await factory.completeGraduation.staticCall(0);
  await (await factory.completeGraduation(0, { gasLimit: 5_000_000 })).wait();
  const graduated = await factory.getWorld(0);
  assert.equal(graduated.phase, 3n, "World reaches permanent phase only after reserve consumption");
  assert.equal(graduated.marketId, marketId, "factory records permanent market id");
  assert.equal(await escrow.released(), true, "escrow permanently marks released reserves");
  assert.equal(await escrow.trackedQuote(), 0n, "no tracked quote remains in escrow");
  assert.equal(await escrow.trackedTokens(), 0n, "no tracked token remains in escrow");
  assert.equal(await coordinator.lastQuoteAmount(), trackedQuote, "coordinator receives exact quote amount");
  assert.equal(await coordinator.lastTokenAmount(), trackedTokens, "coordinator receives exact token amount");
  await rejects(() => factory.completeGraduation(0), "graduation cannot execute twice");

  const laterFee = 10_003n;
  await (await quote.mint(traderAddress, laterFee)).wait();
  await (await quote.connect(trader).approve(world.worldRewardVault, laterFee)).wait();
  await (await rewardVault.connect(trader).depositFee(laterFee)).wait();
  await (await rewardVault.connect(launcher).commitZeroWeightReserves()).wait();
  const laterReserve = await rewardVault.liquidityReserve();
  const coordinatorQuoteBefore = await quote.balanceOf(await coordinator.getAddress());
  await (await escrow.connect(launcher).forwardPostGraduationReserve()).wait();
  assert.equal(
    (await quote.balanceOf(await coordinator.getAddress())) - coordinatorQuoteBefore,
    laterReserve,
    "post-graduation rounding reserve reaches the immutable coordinator",
  );
  assert.equal(await rewardVault.liquidityReserve(), 0n, "later reserve does not become stranded");

  const factoryFunctions = new Set(
    artifact("StockWorldFactory").abi.filter((item) => item.type === "function").map((item) => item.name),
  );
  const escrowFunctions = new Set(
    artifact("StockWorldGraduationEscrow").abi
      .filter((item) => item.type === "function")
      .map((item) => item.name),
  );
  for (const forbidden of ["owner", "withdraw", "rescue", "upgradeTo", "setCoordinator"]) {
    assert.equal(factoryFunctions.has(forbidden), false, `factory must not expose ${forbidden}()`);
    assert.equal(escrowFunctions.has(forbidden), false, `escrow must not expose ${forbidden}()`);
  }

  assert.equal(launcherAddress !== creatorAddress, true, "launcher and creator may be different accounts");
  await eip1193.disconnect();
  console.log("Stock World factory and atomic launch tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
