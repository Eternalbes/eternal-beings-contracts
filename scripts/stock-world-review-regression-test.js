const fs = require("fs");
const assert = require("assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { loadBuild, assertBuild, verifyDeployment } = require("./deployment-build");

async function main() {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(chain);
  const signers = await Promise.all(Array.from({ length: 10 }, (_, i) => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map((signer) => signer.getAddress()));
  const tx = async (promise) => (await promise).wait();
  const deploy = async (name, args) => {
    const item = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
    const c = await new ethers.ContractFactory(item.abi, item.bytecode, signers[0]).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const mineTo = async (height) => {
    while (BigInt(await chain.request({ method: "eth_blockNumber", params: [] })) < height) {
      await chain.request({ method: "evm_mine", params: [] });
    }
  };
  try {
    const token = await deploy("WorldToken", ["Rounding", "RND", addresses[0]]);
    const quote = await deploy("MockQuoteAsset", ["Quote", "Q", 6]);
    const vault = await deploy("TokenRewardVault", [await token.getAddress(), await quote.getAddress()]);
    const vaultAddress = await vault.getAddress();
    async function enter(i) {
      await tx(token.transfer(addresses[i], 1n));
      await tx(token.connect(signers[i]).approve(vaultAddress, 1n));
      await tx(vault.connect(signers[i]).queueStake(1n));
      await tx(vault.connect(signers[i]).activateStake());
    }
    for (let i = 1; i <= 3; i++) await enter(i);
    await tx(quote.mint(addresses[0], 1000n));
    await tx(quote.approve(vaultAddress, 1000n));
    await tx(vault.depositReward(2n));
    for (let i = 4; i <= 6; i++) await enter(i);
    await tx(vault.depositReward(3n));
    const pending = await Promise.all(addresses.slice(1, 7).map((a) => vault.pendingRewards(a)));
    assert(pending.reduce((a, b) => a + b, 0n) <= 5n, "joining cannot introduce historical fractions");
    assert.deepEqual(pending.slice(3), [0n, 0n, 0n], "late entrants earned only half a unit each");
    // Repeated checkpoints, withdrawals, re-entry, and tiny deposits must remain solvent.
    for (let round = 0; round < 12; round++) {
      await tx(vault.depositReward(BigInt(round % 3 + 1)));
      const i = round % 6 + 1;
      await tx(vault.connect(signers[i]).withdrawStake(1n, addresses[i]));
      await tx(token.connect(signers[i]).approve(vaultAddress, 1n));
      await tx(vault.connect(signers[i]).queueStake(1n));
      await tx(vault.connect(signers[i]).activateStake());
      let owed = 0n;
      for (let j = 1; j <= 6; j++) owed += await vault.pendingRewards(addresses[j]);
      assert(owed <= await quote.balanceOf(vaultAddress), "all reward liabilities stay funded");
      if (await vault.pendingRewards(addresses[i]) > 0n) await tx(vault.connect(signers[i]).claim(addresses[i]));
    }

    const emptyVault = await deploy("TokenRewardVault", [await token.getAddress(), await quote.getAddress()]);
    const worldVault = await deploy("WorldRewardVault", [await quote.getAddress(), await emptyVault.getAddress(),
      addresses[0], addresses[0], 4000, 4000, 2000]);
    const modules = await deploy("MockWorldModules", [await worldVault.getAddress()]);
    await tx(worldVault.bindWorldModules(await modules.getAddress(), await modules.getAddress()));
    await tx(quote.approve(await worldVault.getAddress(), 1000));
    for (let i = 1; i <= 3; i++) await tx(modules.checkpoint(i, addresses[0], 1));
    await tx(worldVault.depositFee(5));
    for (let i = 4; i <= 6; i++) await tx(modules.checkpoint(i, addresses[0], 1));
    await tx(worldVault.depositFee(8));
    for (let i = 1; i <= 6; i++) await tx(modules.checkpoint(i, addresses[0], 1));
    const nftOwed = await worldVault.nftClaimable(addresses[0]);
    assert(nftOwed <= 5n, "NFT rewards cannot exceed the allocated NFT fees");
    const fractionBefore = await worldVault.rewardRemainder(addresses[0]);
    await tx(modules.checkpoint(1, addresses[0], 1));
    assert.equal(await worldVault.rewardRemainder(addresses[0]), fractionBefore,
      "public settlement cannot erase beneficiary fractions");
    // A transferred NFT leaves the sender's earned fraction with the sender.
    await tx(modules.checkpoint(1, addresses[1], 1));
    assert.equal(await worldVault.rewardRemainder(addresses[1]), 0n);
    assert.equal(await worldVault.rewardRemainder(addresses[0]), fractionBefore);
    await tx(worldVault.claimNftReward(addresses[0]));
    await tx(worldVault.claimCreatorReward(addresses[0]));
    await tx(worldVault.commitZeroWeightReserves());
    await tx(modules.releaseReserve());

    const nft = await deploy("MockFairMintNft", [20]);
    const controller = await deploy("FairMintController", [await nft.getAddress(), 20, 30, 40, 600, 1, 2]);
    const target = await controller.entropyBlock(0);
    const secrets = addresses.map((_, i) => ethers.id(`committed-secret-${i}`));
    for (let i = 1; i <= 9; i++) {
      await tx(controller.connect(signers[i]).commitMint(await controller.computeCommitment(addresses[i], 0, secrets[i])));
    }
    await mineTo(await controller.startBlock() + 30n);
    for (let i = 1; i <= 3; i++) await tx(controller.connect(signers[i]).revealMint(0, secrets[i]));
    // Replay the attack: enumerate subsets of already committed attacker secrets
    // before reveal closes and choose an attacker winner in the old late formula.
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const chainId = (await provider.getNetwork()).chainId;
    const ca = await controller.getAddress();
    let chosen;
    function search(order, entropy, count) {
      if (chosen) return;
      if (order.length) {
        const seed = ethers.keccak256(coder.encode(
          ["bytes32", "uint256", "address", "uint256", "uint256", "string"],
          [entropy, 0, ca, chainId, target, "LATE_ENTROPY"]));
        if (Number(BigInt(seed) % BigInt(count)) >= 3) { chosen = order; return; }
      }
      if (order.length === 4) return;
      for (let i = 4; i <= 9; i++) if (!order.includes(i)) {
        search([...order, i], ethers.keccak256(coder.encode(
          ["bytes32", "address", "bytes32", "uint32"], [entropy, addresses[i], secrets[i], count + 1])), count + 1);
        if (chosen) return;
      }
    }
    search([], (await controller.epochState(0)).revealEntropy, 3);
    assert(chosen, "attack finds a favorable old fallback seed");
    for (const i of chosen) await tx(controller.connect(signers[i]).revealMint(0, secrets[i]));
    await mineTo(target + 257n);
    await tx(controller.finalizeEpoch(0));
    const late = await controller.epochState(0);
    assert.equal(late.expired, true);
    assert.equal(late.winnerCount, 0n);
    assert.equal(late.finalSeed, ethers.ZeroHash);
    assert.equal(await controller.totalReserved(), 0n);
    for (const i of chosen) await assert.rejects(() => controller.connect(signers[i]).claimMint.staticCall(0));
    // The next epoch still works; timely finalization preserves winners after
    // the hash expires and does not shorten the advertised claim window.
    const epoch = await controller.currentEpoch() + 1n;
    await mineTo(await controller.epochStart(epoch));
    await tx(controller.connect(signers[1]).commitMint(await controller.computeCommitment(addresses[1], epoch, secrets[1])));
    await mineTo(await controller.epochStart(epoch) + 30n);
    await tx(controller.connect(signers[1]).revealMint(epoch, secrets[1]));
    const nextTarget = await controller.entropyBlock(epoch);
    await mineTo(nextTarget + 1n);
    await tx(controller.finalizeEpoch(epoch));
    await mineTo(nextTarget + 257n);
    await tx(controller.connect(signers[1]).claimMint(epoch));
    assert.equal(await nft.totalMinted(), 1n);

    const build = loadBuild(["MockFairMintNft"]);
    assertBuild({ buildId: build.buildId }, build.buildId);
    assert.throws(() => assertBuild({ buildId: ethers.ZeroHash }, build.buildId), /build mismatch/);
    const deployTx = nft.deploymentTransaction();
    const receipt = await deployTx.wait();
    const saved = { address: await nft.getAddress(), transactionHash: deployTx.hash,
      initCodeHash: ethers.keccak256(deployTx.data), runtimeCodeHash: ethers.keccak256(await provider.getCode(await nft.getAddress())) };
    const verified = await verifyDeployment(provider, saved, deployTx.data, addresses[0]);
    assert.equal(verified.receipt.blockNumber, receipt.blockNumber);
    await assert.rejects(() => verifyDeployment(provider, saved, `${deployTx.data}00`, addresses[0]), /constructor or bytecode/);
    await assert.rejects(() => verifyDeployment(provider, { ...saved, address: vaultAddress }, deployTx.data, addresses[0]), /receipt\/address/);
    await assert.rejects(() => verifyDeployment(provider, { ...saved, runtimeCodeHash: ethers.ZeroHash }, deployTx.data, addresses[0]), /runtime code/);
    console.log("Stock World review regressions passed: reward solvency, late-lottery rejection, build and receipt binding");
  } finally {
    provider.destroy();
    await chain.disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
