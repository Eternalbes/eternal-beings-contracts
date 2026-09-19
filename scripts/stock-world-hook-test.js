const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

const MASK_128 = (1n << 128n) - 1n;
const SIGN_256 = 1n << 255n;
const MOD_256 = 1n << 256n;

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

function packBalanceDelta(amount0, amount1) {
  const unsigned = ((BigInt(amount0) & MASK_128) << 128n) | (BigInt(amount1) & MASK_128);
  return unsigned >= SIGN_256 ? unsigned - MOD_256 : unsigned;
}

function beforeSpecifiedDelta(packed) {
  return BigInt.asIntN(128, BigInt(packed) >> 128n);
}

function swapDeltaFor({ quoteIsCurrency0, quoteDelta, otherDelta }) {
  return quoteIsCurrency0
    ? packBalanceDelta(quoteDelta, otherDelta)
    : packBalanceDelta(otherDelta, quoteDelta);
}

function findHookSalt(deployer, initCode, requiredFlags) {
  const initCodeHash = ethers.keccak256(initCode);
  for (let candidate = 0n; candidate < 250_000n; candidate += 1n) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(candidate), 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if ((BigInt(predicted) & 0x3fffn) === requiredFlags) return { salt, predicted };
  }
  throw new Error("unable to mine StockWorldHook CREATE2 permission address");
}

async function main() {
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
  const create2Deployer = await deploy("MockCreate2Deployer", authority);
  const hookArtifact = artifact("StockWorldHook");
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [await poolManager.getAddress(), authorityAddress],
  );
  const initCode = ethers.concat([hookArtifact.bytecode, constructorArgs]);
  const requiredFlags = 0x20ccn;
  const { salt, predicted } = findHookSalt(await create2Deployer.getAddress(), initCode, requiredFlags);
  await (await create2Deployer.deploy(salt, initCode, { gasLimit: 12_000_000 })).wait();
  const hook = new ethers.Contract(predicted, hookArtifact.abi, authority);
  assert.equal(await hook.hookPermissionsValid(), true, "CREATE2 address carries every required v4 hook flag");
  assert.equal(BigInt(predicted) & 0x3fffn, requiredFlags, "hook permission mask is exactly 0x20cc");

  const permit2 = await deploy("MockV4Permit2", authority);
  const positionManager = await deploy("MockV4PositionManager", authority, [
    await poolManager.getAddress(),
    await permit2.getAddress(),
  ]);
  const guard = await deploy("StockWorldGraduationGuard", authority);
  const locker = await deploy("StockWorldLiquidityLocker", authority, [await positionManager.getAddress()]);
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
  await rejects(
    async () => hook.connect(outsider).bindCoordinator(await coordinator.getAddress()),
    "only the deployment binder may bind the coordinator",
  );
  await (await hook.bindCoordinator(await coordinator.getAddress())).wait();
  await rejects(
    async () => hook.bindCoordinator(await coordinator.getAddress()),
    "coordinator binding cannot be changed",
  );

  const factory = await deploy("MockV4CanonicalFactory", authority, [await coordinator.getAddress()]);
  await (await coordinator.bindFactory(await factory.getAddress())).wait();

  const quote = await deploy("MockQuoteAsset", authority, ["Mock USD", "mUSD", 6]);
  const token = await deploy("WorldToken", authority, ["Hook World", "HOOKW", authorityAddress]);
  const rewardVault = await deploy("MockV4RewardVault", authority, [await quote.getAddress()]);
  const escrow = await deploy("MockV4GraduationEscrow", authority, [
    await factory.getAddress(),
    await coordinator.getAddress(),
    await token.getAddress(),
    await quote.getAddress(),
    await rewardVault.getAddress(),
  ]);
  const quoteAmount = 907_200_000n;
  const totalTokenAmount = ethers.parseEther("100000");
  const poolTokenAmount = ethers.parseEther("90720");
  await (await quote.mint(authorityAddress, quoteAmount)).wait();
  await (await quote.transfer(await escrow.getAddress(), quoteAmount)).wait();
  await (await token.transfer(await escrow.getAddress(), totalTokenAmount)).wait();
  await (await escrow.arm(quoteAmount, totalTokenAmount)).wait();
  await (await factory.setCanonicalWorld(7, await token.getAddress())).wait();

  const tokenAddress = await token.getAddress();
  const quoteAddress = await quote.getAddress();
  const quoteIsCurrency0 = quoteAddress.toLowerCase() < tokenAddress.toLowerCase();
  const poolKey = quoteIsCurrency0
    ? [quoteAddress, tokenAddress, 0, 60, await hook.getAddress()]
    : [tokenAddress, quoteAddress, 0, 60, await hook.getAddress()];
  await rejects(
    async () => poolManager.connect(outsider).initialize(poolKey, 1n << 96n),
    "third parties cannot pre-initialize a canonical hook pool",
  );
  await rejects(
    async () =>
      hook.connect(outsider).registerWorldPool(
        poolKey,
        await factory.getAddress(),
        7,
        tokenAddress,
        quoteAddress,
        await rewardVault.getAddress(),
      ),
    "accounts cannot forge a World registration",
  );

  await (
    await factory.callCreate(
      7,
      tokenAddress,
      quoteAddress,
      await escrow.getAddress(),
      quoteAmount,
      totalTokenAmount,
      poolTokenAmount,
      { gasLimit: 20_000_000 },
    )
  ).wait();
  const market = await coordinator.getMarket(await factory.getAddress(), 7);
  const pool = await hook.getPool(market.marketId);
  assert.equal(pool.registered, true, "graduation registers the permanent pool atomically");
  assert.equal(pool.worldToken, tokenAddress, "registered pool records the World Token");
  assert.equal(pool.quoteAsset, quoteAddress, "registered pool records the quote asset");
  assert.equal(pool.rewardVault, await rewardVault.getAddress(), "registered pool records the reward vault");

  const hookSelector = new ethers.Interface(hookArtifact.abi);
  assert.equal(
    hookSelector.getFunction("beforeInitialize").selector,
    ethers.id("beforeInitialize(address,(address,address,uint24,int24,address),uint160)").slice(0, 10),
    "beforeInitialize selector matches v4",
  );
  assert.equal(
    hookSelector.getFunction("beforeSwap").selector,
    ethers.id("beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)").slice(0, 10),
    "beforeSwap selector matches v4",
  );
  assert.equal(
    hookSelector.getFunction("afterSwap").selector,
    ethers.id("afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)").slice(0, 10),
    "afterSwap selector matches v4",
  );

  const swapper = outsiderAddress;
  const specifiedQuoteExactIn = { zeroForOne: quoteIsCurrency0, amountSpecified: -10_000n, sqrtPriceLimitX96: 1 };
  const exactInCoreDelta = swapDeltaFor({ quoteIsCurrency0, quoteDelta: -9_900n, otherDelta: 5_000n });
  let result = await poolManager.simulateSwap.staticCall(
    await hook.getAddress(), swapper, poolKey, specifiedQuoteExactIn, exactInCoreDelta,
  );
  assert.equal(beforeSpecifiedDelta(result[0]), 100n, "exact-input quote fee is removed before the core swap");
  assert.equal(result[1], 0n, "specified quote is not charged twice after the swap");
  await (await poolManager.simulateSwap(await hook.getAddress(), swapper, poolKey, specifiedQuoteExactIn, exactInCoreDelta)).wait();

  const specifiedQuoteExactOut = { zeroForOne: !quoteIsCurrency0, amountSpecified: 9_900n, sqrtPriceLimitX96: 1 };
  const exactOutCoreDelta = swapDeltaFor({ quoteIsCurrency0, quoteDelta: 10_000n, otherDelta: -5_000n });
  result = await poolManager.simulateSwap.staticCall(
    await hook.getAddress(), swapper, poolKey, specifiedQuoteExactOut, exactOutCoreDelta,
  );
  assert.equal(beforeSpecifiedDelta(result[0]), 100n, "exact-output quote is grossed up without reducing requested output");
  assert.equal(result[1], 0n, "exact-output specified quote is charged once");
  await (await poolManager.simulateSwap(await hook.getAddress(), swapper, poolKey, specifiedQuoteExactOut, exactOutCoreDelta)).wait();

  const unspecifiedQuoteOutput = { zeroForOne: !quoteIsCurrency0, amountSpecified: -5_000n, sqrtPriceLimitX96: 1 };
  const quoteOutputDelta = swapDeltaFor({ quoteIsCurrency0, quoteDelta: 10_000n, otherDelta: -5_000n });
  result = await poolManager.simulateSwap.staticCall(
    await hook.getAddress(), swapper, poolKey, unspecifiedQuoteOutput, quoteOutputDelta,
  );
  assert.equal(result[0], 0n, "World Token specified input has no pre-swap quote fee");
  assert.equal(result[1], 100n, "actual quote output is charged after the swap");
  await (await poolManager.simulateSwap(await hook.getAddress(), swapper, poolKey, unspecifiedQuoteOutput, quoteOutputDelta)).wait();

  const unspecifiedQuoteInput = { zeroForOne: quoteIsCurrency0, amountSpecified: 5_000n, sqrtPriceLimitX96: 1 };
  const quoteInputDelta = swapDeltaFor({ quoteIsCurrency0, quoteDelta: -9_900n, otherDelta: 5_000n });
  result = await poolManager.simulateSwap.staticCall(
    await hook.getAddress(), swapper, poolKey, unspecifiedQuoteInput, quoteInputDelta,
  );
  assert.equal(result[0], 0n, "World Token specified output has no pre-swap quote fee");
  assert.equal(result[1], 100n, "actual quote input is grossed up after the swap");
  await (await poolManager.simulateSwap(await hook.getAddress(), swapper, poolKey, unspecifiedQuoteInput, quoteInputDelta)).wait();

  assert.equal(await hook.pendingQuote(market.marketId), 400n, "all four swap forms accrue the same 1% quote fee");
  assert.equal(await hook.totalPendingQuoteByAsset(quoteAddress), 400n, "global pending liability is conserved");

  const managerBeforePartial = await quote.balanceOf(await poolManager.getAddress());
  await rejects(
    async () =>
      poolManager.simulateSwap(
        await hook.getAddress(),
        swapper,
        poolKey,
        specifiedQuoteExactIn,
        swapDeltaFor({ quoteIsCurrency0, quoteDelta: -5_000n, otherDelta: 2_500n }),
      ),
    "specified-quote partial fills revert instead of overcharging",
  );
  assert.equal(await hook.pendingQuote(market.marketId), 400n, "rejected partial fill rolls fee accounting back");
  assert.equal(await quote.balanceOf(await poolManager.getAddress()), managerBeforePartial, "rejected partial fill rolls transfer back");

  const forcedBalance = 77n;
  await (await quote.mint(await hook.getAddress(), forcedBalance)).wait();
  await (await hook.connect(outsider).sweepPoolFees(market.marketId)).wait();
  assert.equal(await rewardVault.totalFeesDeposited(), 400n, "permissionless sweep deposits every tracked fee");
  assert.equal(await quote.balanceOf(await rewardVault.getAddress()), 400n, "reward vault receives exact quote assets");
  assert.equal(await hook.pendingQuote(market.marketId), 0n, "pool pending balance clears after delivery");
  assert.equal(await hook.totalPendingQuoteByAsset(quoteAddress), 0n, "global pending liability clears after delivery");
  assert.equal(await quote.balanceOf(await hook.getAddress()), forcedBalance, "forced balances are not misattributed or swept");
  assert.equal(
    await quote.allowance(await hook.getAddress(), await rewardVault.getAddress()),
    0n,
    "reward-vault approval is explicitly revoked",
  );
  await rejects(() => hook.sweepPoolFees(market.marketId), "empty fee sweeps are rejected");

  const publicFunctions = new Set(
    hookArtifact.abi.filter((item) => item.type === "function").map((item) => item.name),
  );
  for (const forbidden of ["owner", "withdraw", "rescue", "setFee", "setCoordinator", "upgradeTo"]) {
    assert.equal(publicFunctions.has(forbidden), false, `hook must not expose ${forbidden}()`);
  }

  await eip1193.disconnect();
  console.log("Stock World autonomous quote-fee hook tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
