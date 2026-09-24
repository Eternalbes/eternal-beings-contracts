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

async function createEscrow({ signer, factory, coordinator, token, quote, quoteAmount, tokenAmount }) {
  const rewardVault = await deploy("MockV4RewardVault", signer, [await quote.getAddress()]);
  const escrow = await deploy("MockV4GraduationEscrow", signer, [
    await factory.getAddress(),
    await coordinator.getAddress(),
    await token.getAddress(),
    await quote.getAddress(),
    await rewardVault.getAddress(),
  ]);
  await (await token.transfer(await escrow.getAddress(), tokenAmount)).wait();
  await (await quote.transfer(await escrow.getAddress(), quoteAmount)).wait();
  await (await escrow.arm(quoteAmount, tokenAmount)).wait();
  return { rewardVault, escrow };
}

async function main() {
  const poolManagerInterface = new ethers.Interface(artifact("IStockWorldV4PoolManager").abi);
  const positionManagerInterface = new ethers.Interface(artifact("IStockWorldV4PositionManager").abi);
  const permit2Interface = new ethers.Interface(artifact("IStockWorldPermit2").abi);
  assert.equal(
    poolManagerInterface.getFunction("initialize").selector,
    ethers.id("initialize((address,address,uint24,int24,address),uint160)").slice(0, 10),
    "PoolManager selector matches the canonical v4 PoolKey ABI",
  );
  assert.equal(
    positionManagerInterface.getFunction("modifyLiquidities").selector,
    ethers.id("modifyLiquidities(bytes,uint256)").slice(0, 10),
    "PositionManager selector matches the canonical v4 ABI",
  );
  assert.equal(
    permit2Interface.getFunction("approve").selector,
    ethers.id("approve(address,address,uint160,uint48)").slice(0, 10),
    "Permit2 selector matches the canonical allowance ABI",
  );

  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", allowUnlimitedContractSize: false },
    miner: { blockGasLimit: 100_000_000 },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [authority, outsider] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const [authorityAddress, outsiderAddress] = await Promise.all([
    authority.getAddress(),
    outsider.getAddress(),
  ]);

  const poolManager = await deploy("MockV4PoolManager", authority);
  const permit2 = await deploy("MockV4Permit2", authority);
  const positionManager = await deploy("MockV4PositionManager", authority, [
    await poolManager.getAddress(),
    await permit2.getAddress(),
  ]);
  const hook = await deploy("MockStockWorldHookRegistry", authority);
  const guard = await deploy("StockWorldGraduationGuard", authority);
  const locker = await deploy("StockWorldLiquidityLocker", authority, [await positionManager.getAddress()]);
  const wrongPoolManager = await deploy("MockV4PoolManager", authority);
  const mismatchedPositionManager = await deploy("MockV4PositionManager", authority, [
    await wrongPoolManager.getAddress(),
    await permit2.getAddress(),
  ]);
  await rejects(
    async () =>
      deploy("StockWorldGraduationCoordinator", authority, [
        await poolManager.getAddress(),
        await mismatchedPositionManager.getAddress(),
        await permit2.getAddress(),
        await hook.getAddress(),
        await guard.getAddress(),
        await locker.getAddress(),
        authorityAddress,
        0,
        60,
      ]),
    "constructor rejects mismatched v4 infrastructure",
  );
  await rejects(
    async () =>
      deploy("StockWorldGraduationCoordinator", authority, [
        await poolManager.getAddress(),
        await positionManager.getAddress(),
        await permit2.getAddress(),
        await hook.getAddress(),
        await guard.getAddress(),
        await locker.getAddress(),
        authorityAddress,
        3_000,
        60,
      ]),
    "ownerless permanent LP rejects an inaccessible core fee",
  );
  const coordinator = await deploy("StockWorldGraduationCoordinator", authority, [
    await poolManager.getAddress(),
    await positionManager.getAddress(),
    await permit2.getAddress(),
    await hook.getAddress(),
    await guard.getAddress(),
    await locker.getAddress(),
    authorityAddress,
    0,
    60,
  ]);
  const factory = await deploy("MockV4CanonicalFactory", authority, [await coordinator.getAddress()]);

  await rejects(
    async () => factory.callPreflight(0, outsiderAddress, outsiderAddress, 1, 1),
    "graduation cannot run before the canonical factory is bound",
  );
  await rejects(
    async () => coordinator.connect(outsider).bindFactory(await factory.getAddress()),
    "only the deployment binder may bind the factory",
  );
  await (await coordinator.bindFactory(await factory.getAddress())).wait();
  await rejects(
    async () => coordinator.bindFactory(await factory.getAddress()),
    "factory binding is immutable",
  );
  await rejects(
    () => coordinator.connect(outsider).onPostGraduationReserve(1),
    "unregistered callers cannot create attributed reserve liabilities",
  );

  const quote = await deploy("MockQuoteAsset", authority, ["Mock USD", "mUSD", 6]);
  const token = await deploy("WorldToken", authority, ["World One", "WRLD1", authorityAddress]);
  const quoteAmount = 907_200_000n;
  const totalTokenAmount = ethers.parseEther("100000");
  const poolTokenAmount = ethers.parseEther("90720");
  await (await quote.mint(authorityAddress, quoteAmount * 3n)).wait();
  await (await factory.setCanonicalWorld(1, await token.getAddress())).wait();

  const { rewardVault, escrow } = await createEscrow({
    signer: authority,
    factory,
    coordinator,
    token,
    quote,
    quoteAmount,
    tokenAmount: totalTokenAmount,
  });
  await factory.callPreflight(1, await token.getAddress(), await quote.getAddress(), quoteAmount, poolTokenAmount);
  await rejects(
    async () =>
      coordinator.preflight(
        1,
        await token.getAddress(),
        await quote.getAddress(),
        quoteAmount,
        poolTokenAmount,
      ),
    "accounts cannot bypass the canonical factory",
  );
  await rejects(
    async () =>
      factory.callCreate(
        1,
        await token.getAddress(),
        await quote.getAddress(),
        await escrow.getAddress(),
        quoteAmount,
        totalTokenAmount + 1n,
        poolTokenAmount,
      ),
    "escrow accounting mismatch is rejected before release",
  );
  assert.equal(await escrow.released(), false, "invalid accounting does not consume escrow reserves");

  await (
    await factory.callCreate(
      1,
      await token.getAddress(),
      await quote.getAddress(),
      await escrow.getAddress(),
      quoteAmount,
      totalTokenAmount,
      poolTokenAmount,
      { gasLimit: 20_000_000 },
    )
  ).wait();

  const market = await coordinator.getMarket(await factory.getAddress(), 1);
  assert.notEqual(market.marketId, ethers.ZeroHash, "coordinator records the permanent market");
  assert.equal(market.positionId, 1n, "predicted v4 position id is recorded");
  assert.equal(market.rewardVault, await rewardVault.getAddress(), "World reward destination is preserved");
  assert.equal(await poolManager.initialized(market.marketId), true, "v4 pool is initialized atomically");
  assert.equal(await hook.factoryOf(market.marketId), await factory.getAddress(), "hook receives canonical factory");
  assert.equal(await hook.worldIdOf(market.marketId), 1n, "hook receives canonical World id");
  assert.equal(await hook.rewardVaultOf(market.marketId), await rewardVault.getAddress(), "hook receives reward vault");
  assert.equal(await positionManager.ownerOf(1), await locker.getAddress(), "LP NFT is minted directly to locker");

  const locked = await locker.getLockedPosition(await factory.getAddress(), 1);
  const worldIsCurrency0 = (await token.getAddress()).toLowerCase() < (await quote.getAddress()).toLowerCase();
  const tokenDust = worldIsCurrency0 ? 1n : 2n;
  const quoteDust = worldIsCurrency0 ? 2n : 1n;
  assert.equal(locked.positionLocked, true, "locker finalizes permanent position custody");
  assert.equal(
    locked.lockedTokenSupply,
    totalTokenAmount - poolTokenAmount + tokenDust,
    "virtual-reserve remainder and mint dust are permanently locked",
  );
  assert.equal(await coordinator.pendingQuoteByEscrow(await escrow.getAddress()), quoteDust, "quote dust is attributed");
  assert.equal(await quote.balanceOf(await coordinator.getAddress()), quoteDust, "attributed quote dust remains conserved");
  assert.equal(await token.balanceOf(await coordinator.getAddress()), 0n, "coordinator retains no World Token");

  const executorAddress = await coordinator.executor();
  assert.equal(await token.balanceOf(executorAddress), 0n, "executor retains no World Token");
  assert.equal(await quote.balanceOf(executorAddress), 0n, "executor retains no quote asset");
  assert.equal(await token.allowance(executorAddress, await permit2.getAddress()), 0n, "token Permit2 approval is revoked");
  assert.equal(await quote.allowance(executorAddress, await permit2.getAddress()), 0n, "quote Permit2 approval is revoked");
  assert.equal(await token.allowance(await coordinator.getAddress(), executorAddress), 0n, "coordinator token approval is revoked");
  assert.equal(await quote.allowance(await coordinator.getAddress(), executorAddress), 0n, "coordinator quote approval is revoked");
  assert.equal(
    await token.allowance(await coordinator.getAddress(), await locker.getAddress()),
    0n,
    "coordinator locker approval is revoked",
  );
  const tokenPermit2 = await permit2.allowance(executorAddress, await token.getAddress(), await positionManager.getAddress());
  const quotePermit2 = await permit2.allowance(executorAddress, await quote.getAddress(), await positionManager.getAddress());
  assert.equal(tokenPermit2.amount, 0n, "token PositionManager allowance is revoked");
  assert.equal(quotePermit2.amount, 0n, "quote PositionManager allowance is revoked");
  await rejects(
    async () =>
      factory.callCreate(
        1,
        await token.getAddress(),
        await quote.getAddress(),
        await escrow.getAddress(),
        quoteAmount,
        totalTokenAmount,
        poolTokenAmount,
      ),
    "a World cannot create a second permanent market",
  );

  const forwarded = 123_456n;
  await (await quote.mint(await escrow.getAddress(), forwarded)).wait();
  await (await escrow.forwardReserve(forwarded)).wait();
  assert.equal(
    await coordinator.pendingQuoteByEscrow(await escrow.getAddress()),
    quoteDust + forwarded,
    "post-graduation reserve remains attributed to its originating World",
  );
  assert.equal(
    await coordinator.totalPendingQuoteByAsset(await quote.getAddress()),
    quoteDust + forwarded,
    "global quote liability matches per-World accounting",
  );

  const token2 = await deploy("WorldToken", authority, ["World Two", "WRLD2", authorityAddress]);
  await (await factory.setCanonicalWorld(2, await token2.getAddress())).wait();
  const second = await createEscrow({
    signer: authority,
    factory,
    coordinator,
    token: token2,
    quote,
    quoteAmount,
    tokenAmount: totalTokenAmount,
  });
  await (await positionManager.setFailMint(true)).wait();
  await rejects(
    async () =>
      factory.callCreate(
        2,
        await token2.getAddress(),
        await quote.getAddress(),
        await second.escrow.getAddress(),
        quoteAmount,
        totalTokenAmount,
        poolTokenAmount,
        { gasLimit: 20_000_000 },
      ),
    "failed PositionManager mint rolls the entire graduation back",
  );
  assert.equal(await second.escrow.released(), false, "failed v4 mint restores escrow custody");
  assert.equal(await hook.registrationCount(), 1n, "failed v4 mint rolls back hook registration");
  assert.equal(await positionManager.nextTokenId(), 2n, "failed v4 mint consumes no position id");
  const secondKey = await coordinator.worldKey(await factory.getAddress(), 2);
  const failedPoolKey = [
    (await token2.getAddress()).toLowerCase() < (await quote.getAddress()).toLowerCase()
      ? await token2.getAddress()
      : await quote.getAddress(),
    (await token2.getAddress()).toLowerCase() < (await quote.getAddress()).toLowerCase()
      ? await quote.getAddress()
      : await token2.getAddress(),
    0,
    60,
    await hook.getAddress(),
  ];
  const failedPoolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"],
      [failedPoolKey],
    ),
  );
  assert.equal(await poolManager.initialized(failedPoolId), false, "failed v4 mint rolls back pool initialization");
  assert.equal(
    (await coordinator.getMarket(await factory.getAddress(), 2)).marketId,
    ethers.ZeroHash,
    "failed v4 mint creates no market record",
  );
  assert.notEqual(secondKey, ethers.ZeroHash, "canonical World storage key remains deterministic");
  await (await positionManager.setFailMint(false)).wait();
  await (
    await factory.callCreate(
      2,
      await token2.getAddress(),
      await quote.getAddress(),
      await second.escrow.getAddress(),
      quoteAmount,
      totalTokenAmount,
      poolTokenAmount,
      { gasLimit: 20_000_000 },
    )
  ).wait();
  assert.equal(await second.escrow.released(), true, "same World can retry after downstream recovery");

  const nativeToken = await deploy("WorldToken", authority, ["Native World", "NATIVE", authorityAddress]);
  const nativeRewardVault = await deploy("MockV4RewardVault", authority, [ethers.ZeroAddress]);
  const nativeEscrow = await deploy("MockV4GraduationEscrow", authority, [
    await factory.getAddress(),
    await coordinator.getAddress(),
    await nativeToken.getAddress(),
    ethers.ZeroAddress,
    await nativeRewardVault.getAddress(),
  ]);
  const nativeQuoteAmount = ethers.parseEther("1");
  const nativeForwarded = 123_456n;
  await (await authority.sendTransaction({ to: await nativeEscrow.getAddress(), value: nativeQuoteAmount })).wait();
  await (await nativeToken.transfer(await nativeEscrow.getAddress(), totalTokenAmount)).wait();
  await (await nativeEscrow.arm(nativeQuoteAmount, totalTokenAmount)).wait();
  await (await factory.setCanonicalWorld(3, await nativeToken.getAddress())).wait();

  const nativeGraduationReceipt = await (
    await factory.callCreate(
      3,
      await nativeToken.getAddress(),
      ethers.ZeroAddress,
      await nativeEscrow.getAddress(),
      nativeQuoteAmount,
      totalTokenAmount,
      poolTokenAmount,
      { gasLimit: 20_000_000 },
    )
  ).wait();

  const nativeMarket = await coordinator.getMarket(await factory.getAddress(), 3);
  assert.equal(nativeMarket.quoteAsset, ethers.ZeroAddress, "native ETH remains the canonical quote identity");
  assert.equal(nativeMarket.positionId, 3n, "native ETH graduation mints the next permanent LP position");
  assert.equal(await positionManager.ownerOf(3), await locker.getAddress(), "native ETH LP is permanently locked");
  assert.equal(
    await provider.getBalance(await poolManager.getAddress(), nativeGraduationReceipt.blockNumber),
    nativeQuoteAmount - 1n,
    "native ETH is settled into the v4 pool and only deterministic mint dust is returned",
  );
  assert.equal(
    await coordinator.pendingQuoteByEscrow(await nativeEscrow.getAddress()),
    1n,
    "native ETH mint dust is attributed to its World escrow",
  );
  assert.equal(
    await provider.getBalance(executorAddress, nativeGraduationReceipt.blockNumber),
    0n,
    "executor retains no native ETH",
  );

  await (await authority.sendTransaction({ to: await nativeEscrow.getAddress(), value: nativeForwarded })).wait();
  await (await nativeEscrow.forwardReserve(nativeForwarded)).wait();
  assert.equal(
    await coordinator.pendingQuoteByEscrow(await nativeEscrow.getAddress()),
    1n + nativeForwarded,
    "post-graduation native ETH remains attributed to the originating World",
  );
  assert.equal(
    await coordinator.totalPendingQuoteByAsset(ethers.ZeroAddress),
    1n + nativeForwarded,
    "global native ETH liabilities remain conserved",
  );

  const coordinatorFunctions = new Set(
    artifact("StockWorldGraduationCoordinator").abi
      .filter((item) => item.type === "function")
      .map((item) => item.name),
  );
  const executorFunctions = new Set(
    artifact("StockWorldGraduationExecutor").abi
      .filter((item) => item.type === "function")
      .map((item) => item.name),
  );
  for (const forbidden of ["owner", "withdraw", "rescue", "upgradeTo", "setPoolManager", "setExecutor"]) {
    assert.equal(coordinatorFunctions.has(forbidden), false, `coordinator must not expose ${forbidden}()`);
    assert.equal(executorFunctions.has(forbidden), false, `executor must not expose ${forbidden}()`);
  }

  await eip1193.disconnect();
  console.log("Stock World v4 coordinator, executor, rollback, and custody tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
