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

async function main() {
  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const [coordinator, outsider] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const [coordinatorAddress, outsiderAddress] = await Promise.all([
    coordinator.getAddress(),
    outsider.getAddress(),
  ]);

  const guard = await deploy("StockWorldGraduationGuard", coordinator);
  const math = await deploy("MockGraduationMathHarness", coordinator);
  const worldToken = await deploy("WorldToken", coordinator, ["Guard World", "GUARD", coordinatorAddress]);
  const quoteToken = await deploy("MockQuoteAsset", coordinator, ["Mock USD", "mUSD", 6]);
  const quoteAmount = 907_200_000n;
  const poolTokenAmount = ethers.parseEther("90720");

  assert.equal(await math.sqrtPriceAtTick(-887272), 4_295_128_739n, "minimum TickMath boundary matches V4");
  assert.equal(
    await math.sqrtPriceAtTick(-60),
    78_990_846_045_029_531_151_608_375_686n,
    "negative usable tick matches V4",
  );
  assert.equal(
    await math.sqrtPriceAtTick(887272),
    1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n,
    "maximum TickMath boundary matches V4",
  );
  assert.equal(
    await math.poolTokenAmount(
      ethers.parseEther("100000"),
      900_000_000n,
      7_200_000n,
      100_000_000n,
    ),
    poolTokenAmount,
    "virtual quote is removed without changing terminal price",
  );
  await rejects(
    () => math.poolTokenAmount(100, 900, 101, 100),
    "liquidity quote requiring more than all remaining tokens is rejected",
  );

  const seed = await guard.assertSeedable(
    await worldToken.getAddress(),
    await quoteToken.getAddress(),
    60,
    quoteAmount,
    poolTokenAmount,
  );
  assert(seed.sqrtPriceX96 > 0n, "valid full-range seed returns a sqrt price");
  assert(seed.liquidity > 0n, "valid full-range seed returns nonzero liquidity");
  await rejects(
    async () =>
      guard.assertSeedable(
        await worldToken.getAddress(),
        await quoteToken.getAddress(),
        0,
        quoteAmount,
        poolTokenAmount,
      ),
    "zero tick spacing rejected",
  );
  await rejects(
    async () =>
      guard.assertSeedable(
        await worldToken.getAddress(),
        await worldToken.getAddress(),
        60,
        quoteAmount,
        poolTokenAmount,
      ),
    "identical currencies rejected",
  );
  await rejects(
    async () =>
      guard.assertSeedable(
        await worldToken.getAddress(),
        await quoteToken.getAddress(),
        60,
        (1n << 127n),
        poolTokenAmount,
      ),
    "amount above V4 signed delta range rejected",
  );

  const positionManager = await deploy("MockPositionManager", coordinator);
  const locker = await deploy("StockWorldLiquidityLocker", coordinator, [await positionManager.getAddress()]);
  const lockerFactory = await deploy("MockLockerFactory", coordinator, [coordinatorAddress]);
  await (await lockerFactory.setCanonicalWorld(7, await worldToken.getAddress())).wait();

  const lockedAmount = ethers.parseEther("9280");
  await (await worldToken.approve(await locker.getAddress(), lockedAmount)).wait();
  await rejects(
    async () =>
      locker
        .connect(outsider)
        .lockTokenSupply(await lockerFactory.getAddress(), 7, await worldToken.getAddress(), lockedAmount),
    "non-coordinator cannot lock or register balances",
  );
  await (
    await locker.lockTokenSupply(
      await lockerFactory.getAddress(),
      7,
      await worldToken.getAddress(),
      lockedAmount,
    )
  ).wait();
  assert.equal(await worldToken.balanceOf(await locker.getAddress()), lockedAmount, "excess supply is held by locker");

  await (await positionManager.mint(await locker.getAddress(), 42)).wait();
  await (
    await locker.lockPosition(await lockerFactory.getAddress(), 7, await worldToken.getAddress(), 42)
  ).wait();
  const locked = await locker.getLockedPosition(await lockerFactory.getAddress(), 7);
  assert.equal(locked.worldToken, await worldToken.getAddress(), "canonical World token recorded");
  assert.equal(locked.positionId, 42n, "position id recorded");
  assert.equal(locked.lockedTokenSupply, lockedAmount, "permanently removed token amount recorded");
  assert.equal(locked.positionLocked, true, "position custody finalized");
  assert.equal(await positionManager.ownerOf(42), await locker.getAddress(), "position NFT remains owned by locker");
  await rejects(
    async () => locker.lockPosition(await lockerFactory.getAddress(), 7, await worldToken.getAddress(), 42),
    "position cannot be registered twice",
  );
  await rejects(
    async () => locker.connect(outsider).onERC721Received(outsiderAddress, outsiderAddress, 1, "0x"),
    "NFTs from non-position-manager contracts rejected",
  );
  assert.equal(
    await positionManager.callReceiver.staticCall(await locker.getAddress(), 43),
    "0x150b7a02",
    "canonical position manager safe transfer callback accepted",
  );

  const functions = new Set(
    artifact("StockWorldLiquidityLocker").abi
      .filter((item) => item.type === "function")
      .map((item) => item.name),
  );
  for (const forbidden of ["owner", "withdraw", "rescue", "approve", "setApprovalForAll", "unlock", "upgradeTo"]) {
    assert.equal(functions.has(forbidden), false, `locker must not expose ${forbidden}()`);
  }

  await eip1193.disconnect();
  console.log("Stock World graduation guard and permanent locker tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
