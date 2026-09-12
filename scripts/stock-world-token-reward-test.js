const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function loadArtifact(name) {
  const path = `artifacts/${name}.json`;
  if (!fs.existsSync(path)) throw new Error(`Missing ${path}; compile with WRITE_ARTIFACTS=1 first`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function deploy(artifact, signer, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function assertRejects(action, message) {
  let rejected = false;
  try {
    const result = await action();
    if (result && typeof result.wait === "function") await result.wait();
  } catch (_) {
    rejected = true;
  }
  assert(rejected, message);
}

async function main() {
  const tokenArtifact = loadArtifact("WorldToken");
  const quoteArtifact = loadArtifact("MockQuoteAsset");
  const vaultArtifact = loadArtifact("TokenRewardVault");

  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [deployer, alice, bob, feeSource] = await Promise.all([
    provider.getSigner(0),
    provider.getSigner(1),
    provider.getSigner(2),
    provider.getSigner(3),
  ]);

  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();
  const feeSourceAddress = await feeSource.getAddress();

  const token = await deploy(tokenArtifact, deployer, ["Reward World", "RWD", aliceAddress]);
  const quote = await deploy(quoteArtifact, deployer, ["Mock USD", "mUSD", 6]);
  const tokenAddress = await token.getAddress();
  const quoteAddress = await quote.getAddress();
  const vault = await deploy(vaultArtifact, deployer, [tokenAddress, quoteAddress]);

  const aliceStake = ethers.parseEther("600");
  const bobStake = ethers.parseEther("400");
  await (await token.connect(alice).transfer(bobAddress, bobStake)).wait();

  await (await token.connect(alice).approve(await vault.getAddress(), aliceStake)).wait();
  await (await vault.connect(alice).queueStake(aliceStake)).wait();
  await assertRejects(
    () => vault.connect(alice).activateStake.staticCall(),
    "stake cannot activate in its queue block",
  );
  await (await vault.connect(alice).activateStake()).wait();
  assert.equal(await vault.totalActiveStake(), aliceStake, "Alice stake activates in the next block");

  const rewardBeforeBob = 600_000_000n;
  const rewardAfterBob = 1_000_000_000n;
  await (await quote.mint(feeSourceAddress, rewardBeforeBob + rewardAfterBob)).wait();
  await (await quote.connect(feeSource).approve(await vault.getAddress(), rewardBeforeBob + rewardAfterBob)).wait();

  await (await token.connect(bob).approve(await vault.getAddress(), bobStake)).wait();
  await (await vault.connect(bob).queueStake(bobStake)).wait();
  await (await vault.connect(feeSource).depositReward(rewardBeforeBob)).wait();
  assert.equal(await vault.pendingRewards(bobAddress), 0n, "pending stake receives no rewards");
  assert.equal(await vault.pendingRewards(aliceAddress), rewardBeforeBob, "active stake receives current rewards");

  await (await vault.connect(bob).activateStake()).wait();
  assert.equal(await vault.pendingRewards(bobAddress), 0n, "activation cannot claim historical rewards");
  assert.equal(await vault.totalActiveStake(), aliceStake + bobStake, "both stakes become active");

  await (await vault.connect(feeSource).depositReward(rewardAfterBob)).wait();
  const expectedAlice = rewardBeforeBob + 600_000_000n;
  const expectedBob = 400_000_000n;
  assert.equal(await vault.pendingRewards(aliceAddress), expectedAlice, "Alice receives 60 percent after Bob activation");
  assert.equal(await vault.pendingRewards(bobAddress), expectedBob, "Bob receives 40 percent after activation");

  await (await vault.connect(alice).claim(aliceAddress)).wait();
  await (await vault.connect(bob).claim(bobAddress)).wait();
  assert.equal(await quote.balanceOf(aliceAddress), expectedAlice, "Alice claim transfers quote asset");
  assert.equal(await quote.balanceOf(bobAddress), expectedBob, "Bob claim transfers quote asset");
  assert.equal(
    await vault.totalRewardsClaimed(),
    rewardBeforeBob + rewardAfterBob,
    "claimed total matches deposited rewards",
  );

  const cancelAmount = ethers.parseEther("25");
  await (await token.connect(alice).approve(await vault.getAddress(), cancelAmount)).wait();
  await (await vault.connect(alice).queueStake(cancelAmount)).wait();
  const balanceBeforeCancel = await token.balanceOf(aliceAddress);
  await (await vault.connect(alice).withdrawPendingStake(cancelAmount, aliceAddress)).wait();
  assert.equal(await token.balanceOf(aliceAddress), balanceBeforeCancel + cancelAmount, "pending stake can be withdrawn");

  const withdrawAmount = ethers.parseEther("100");
  const balanceBeforeWithdraw = await token.balanceOf(aliceAddress);
  await (await vault.connect(alice).withdrawStake(withdrawAmount, aliceAddress)).wait();
  assert.equal(await token.balanceOf(aliceAddress), balanceBeforeWithdraw + withdrawAmount, "active stake can be withdrawn");
  assert.equal(await vault.totalActiveStake(), aliceStake + bobStake - withdrawAmount, "active total decreases on withdrawal");

  const emptyVault = await deploy(vaultArtifact, deployer, [tokenAddress, quoteAddress]);
  await assertRejects(
    () => emptyVault.connect(feeSource).depositReward(1n),
    "reward deposit without active stake rejected for routing layer to reserve",
  );
  await assertRejects(() => vault.connect(alice).claim(aliceAddress), "empty reward claim rejected");
  await assertRejects(
    () => deploy(vaultArtifact, deployer, [tokenAddress, tokenAddress]),
    "identical stake and reward assets rejected",
  );

  await eip1193.disconnect();
  console.log("Stock World token reward tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
