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
  const [factory, creator, alice, bob, source] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
  );
  const [factoryAddress, creatorAddress, aliceAddress, bobAddress, sourceAddress] = await Promise.all(
    [factory, creator, alice, bob, source].map((signer) => signer.getAddress()),
  );

  const token = await deploy("WorldToken", factory, ["Fee World", "FEE", aliceAddress]);
  const quote = await deploy("MockQuoteAsset", factory, ["Mock USD", "mUSD", 6]);
  const tokenVault = await deploy("TokenRewardVault", factory, [await token.getAddress(), await quote.getAddress()]);
  const worldVault = await deploy("WorldRewardVault", factory, [
    await quote.getAddress(),
    await tokenVault.getAddress(),
    factoryAddress,
    creatorAddress,
    4_000,
    4_000,
    2_000,
  ]);
  const modules = await deploy("MockWorldModules", factory, [await worldVault.getAddress()]);
  const modulesAddress = await modules.getAddress();

  await rejects(
    () => worldVault.connect(alice).bindWorldModules(modulesAddress, modulesAddress),
    "only factory may bind World modules",
  );
  await (await worldVault.bindWorldModules(modulesAddress, modulesAddress)).wait();
  await rejects(
    () => worldVault.bindWorldModules(modulesAddress, modulesAddress),
    "World modules bind exactly once",
  );

  const aliceStake = ethers.parseEther("600");
  await (await token.connect(alice).approve(await tokenVault.getAddress(), aliceStake)).wait();
  await (await tokenVault.connect(alice).queueStake(aliceStake)).wait();
  await (await tokenVault.connect(alice).activateStake()).wait();

  const fee = 1_000_000_000n;
  await (await quote.mint(sourceAddress, fee * 3n)).wait();
  await (await quote.connect(source).approve(await worldVault.getAddress(), fee * 3n)).wait();

  await (await worldVault.connect(source).depositFee(fee)).wait();
  assert.equal(await tokenVault.totalRewardsDeposited(), 400_000_000n, "40 percent routed to Token stake");
  assert.equal(await tokenVault.pendingRewards(aliceAddress), 399_999_999n, "reward index rounds down safely");
  assert.equal(await worldVault.unallocatedNftReserve(), 400_000_000n, "NFT share reserved before first NFT");
  assert.equal(await worldVault.creatorClaimable(), 200_000_000n, "20 percent credited to creator");

  await (await modules.checkpoint(1, aliceAddress, 1)).wait();
  assert.equal(await worldVault.unallocatedNftReserve(), 0n, "first NFT cannot capture pre-mint rewards");
  assert.equal(await worldVault.liquidityReserve(), 400_000_000n, "pre-mint rewards committed to liquidity");

  await (await worldVault.connect(source).depositFee(fee)).wait();
  await (await modules.checkpoint(1, aliceAddress, 1)).wait();
  assert.equal(await worldVault.nftClaimable(aliceAddress), 400_000_000n, "active NFT receives future fee share");

  await (await modules.checkpoint(2, bobAddress, 1)).wait();
  assert.equal(await worldVault.pendingNftReward(2), 0n, "new NFT receives no historical rewards");
  await (await worldVault.connect(source).depositFee(fee)).wait();
  await (await modules.checkpoint(1, aliceAddress, 1)).wait();
  await (await modules.checkpoint(2, bobAddress, 1)).wait();
  assert.equal(await worldVault.nftClaimable(aliceAddress), 600_000_000n, "existing NFT receives weighted reward");
  assert.equal(await worldVault.nftClaimable(bobAddress), 200_000_000n, "new NFT receives only later reward");

  await (await worldVault.connect(alice).claimNftReward(aliceAddress)).wait();
  await (await worldVault.connect(bob).claimNftReward(bobAddress)).wait();
  await rejects(
    () => worldVault.connect(alice).claimCreatorReward(aliceAddress),
    "only the immutable creator may claim creator rewards",
  );
  await (await worldVault.connect(creator).claimCreatorReward(creatorAddress)).wait();
  assert.equal(await quote.balanceOf(aliceAddress), 600_000_000n, "Alice NFT reward paid");
  assert.equal(await quote.balanceOf(bobAddress), 200_000_000n, "Bob NFT reward paid");
  assert.equal(await quote.balanceOf(creatorAddress), 600_000_000n, "creator reward paid");

  await rejects(() => worldVault.connect(alice).releaseLiquidityReserve(), "only reserve recipient may release");
  await (await modules.releaseReserve()).wait();
  assert.equal(await quote.balanceOf(modulesAddress), 400_000_000n, "reserve reaches bound graduation module");

  await (await quote.mint(sourceAddress, 1)).wait();
  await (await quote.connect(source).approve(await worldVault.getAddress(), 1)).wait();
  await (await worldVault.connect(source).depositFee(1)).wait();
  assert.equal(await worldVault.liquidityReserve(), 1n, "fee rounding dust is assigned to liquidity");

  assert.equal(await worldVault.totalFeesDeposited(), fee * 3n + 1n, "all deposited fees tracked");
  assert.equal(await tokenVault.totalRewardsDeposited(), 1_200_000_000n, "all Token shares routed");
  assert.equal(await tokenVault.pendingRewards(aliceAddress), 1_199_999_999n, "only sub-unit index dust remains");
  await rejects(
    () => worldVault.connect(alice).checkpointNftWeight(1, aliceAddress, 2),
    "only NFT controller may change reward weight",
  );

  await eip1193.disconnect();
  console.log("Stock World fee split and NFT reward tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
