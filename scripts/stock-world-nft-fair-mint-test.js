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

async function blockNumber(eip1193) {
  return Number(BigInt(await eip1193.request({ method: "eth_blockNumber", params: [] })));
}

async function mineTo(eip1193, target) {
  while ((await blockNumber(eip1193)) < Number(target)) {
    await eip1193.request({ method: "evm_mine", params: [] });
  }
}

async function nextCommitEpoch(controller, eip1193) {
  let epoch = Number(await controller.currentEpoch());
  let start = Number(await controller.epochStart(epoch));
  const commitBlocks = Number(await controller.commitBlocks());
  const current = await blockNumber(eip1193);
  if (current + 1 >= start + commitBlocks) {
    epoch += 1;
    start = Number(await controller.epochStart(epoch));
    await mineTo(eip1193, start);
  }
  return epoch;
}

async function main() {
  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const signers = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((index) => provider.getSigner(index)));
  const [factory, creator, alice, bob, carol, source, collector] = signers;
  const addresses = await Promise.all(signers.map((signer) => signer.getAddress()));
  const [factoryAddress, creatorAddress, aliceAddress, bobAddress, carolAddress, sourceAddress, collectorAddress] =
    addresses;
  const signerByAddress = new Map(signers.map((signer, index) => [addresses[index].toLowerCase(), signer]));

  const quote = await deploy("MockQuoteAsset", factory, ["Mock USD", "mUSD", 6]);
  const token = await deploy("WorldToken", factory, ["NFT World", "NWORLD", factoryAddress]);
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
  const worldNft = await deploy("WorldNFT", factory, [
    "NFT World Beings",
    "NBEING",
    100,
    factoryAddress,
    await worldVault.getAddress(),
  ]);
  const worldNftAddress = await worldNft.getAddress();
  await rejects(
    () =>
      deploy("FairMintController", factory, [
        worldNftAddress,
        99,
        12,
        8,
        6,
        2,
        2,
      ]),
    "mint controller supply must match its WorldNFT",
  );
  const controller = await deploy("FairMintController", factory, [
    worldNftAddress,
    100,
    12,
    8,
    6,
    2,
    2,
  ]);
  const controllerAddress = await controller.getAddress();
  const modules = await deploy("MockWorldModules", factory, [await worldVault.getAddress()]);

  await rejects(
    () => worldNft.connect(alice).setMintController(controllerAddress),
    "only factory may set mint controller",
  );
  await (await worldNft.setMintController(controllerAddress)).wait();
  await (
    await worldVault.bindWorldModules(worldNftAddress, await modules.getAddress())
  ).wait();
  await rejects(
    () => worldNft.setMintController(controllerAddress),
    "mint controller can only be set once",
  );
  await rejects(
    () => worldNft.connect(alice).mintFromController(aliceAddress, ethers.id("forged-genome")),
    "users cannot mint directly or choose their own genome",
  );
  const nftFunctions = new Set(
    artifact("WorldNFT").abi.filter((entry) => entry.type === "function").map((entry) => entry.name),
  );
  for (const forbidden of ["batchFuse", "fuseBatch", "batchMint", "mint"]) {
    assert.equal(nftFunctions.has(forbidden), false, `WorldNFT must not expose ${forbidden}()`);
  }

  const epoch = Number(await controller.currentEpoch());
  const participants = [
    { signer: alice, address: aliceAddress, secret: ethers.id("alice-secret") },
    { signer: bob, address: bobAddress, secret: ethers.id("bob-secret") },
    { signer: carol, address: carolAddress, secret: ethers.id("carol-secret") },
  ];
  for (const participant of participants) {
    const commitment = await controller.computeCommitment(participant.address, epoch, participant.secret);
    await (await controller.connect(participant.signer).commitMint(commitment)).wait();
  }
  await rejects(
    () => controller.connect(alice).commitMint(ethers.id("duplicate")),
    "one wallet cannot commit twice in an epoch",
  );
  await rejects(
    () => controller.connect(alice).revealMint(epoch, participants[0].secret),
    "reveal cannot run during commit phase",
  );

  await mineTo(
    eip1193,
    Number(await controller.epochStart(epoch)) + Number(await controller.commitBlocks()) + 1,
  );
  await rejects(
    () => controller.connect(alice).revealMint(epoch, ethers.id("wrong-secret")),
    "incorrect reveal secret is rejected",
  );
  await controller.connect(alice).revealMint.staticCall(epoch, participants[0].secret);
  for (const participant of participants) {
    await (
      await controller.connect(participant.signer).revealMint(epoch, participant.secret, { gasLimit: 500_000 })
    ).wait();
  }
  await rejects(
    () => controller.connect(alice).revealMint(epoch, participants[0].secret),
    "one wallet cannot reveal twice",
  );

  await mineTo(eip1193, Number(await controller.entropyBlock(epoch)) + 1);
  await (await controller.finalizeEpoch(epoch)).wait();
  const epochState = await controller.epochState(epoch);
  assert.equal(epochState.revealedCount, 3n, "all reveals are counted");
  assert.equal(epochState.winnerCount, 2n, "exact epoch capacity is selected");
  assert.equal(epochState.usedLateEntropy, false, "future blockhash path is used on time");
  assert.equal(await controller.totalReserved(), 2n, "winner supply is reserved until claim or expiry");

  const winners = [];
  const losers = [];
  for (const participant of participants) {
    (await controller.isWinner(epoch, participant.address) ? winners : losers).push(participant);
  }
  assert.equal(winners.length, 2, "exactly two revealers are winners");
  assert.equal(losers.length, 1, "remaining revealer is deterministically excluded");
  await rejects(
    () => controller.connect(losers[0].signer).claimMint(epoch),
    "non-winner cannot race winners during claim",
  );

  const fee = 1_000_000_000n;
  await (await quote.mint(sourceAddress, fee * 4n)).wait();
  await (await quote.connect(source).approve(await worldVault.getAddress(), fee * 4n)).wait();
  await (await worldVault.connect(source).depositFee(fee)).wait();
  assert.equal(await worldVault.unallocatedNftReserve(), 400_000_000n, "pre-mint NFT fees are reserved");

  await (await controller.connect(winners[0].signer).claimMint(epoch)).wait();
  await (await controller.connect(winners[1].signer).claimMint(epoch)).wait();
  assert.equal(await controller.totalReserved(), 0n, "claimed reservations are consumed");
  assert.equal(await controller.totalMinted(), 2n, "controller tracks historical mints");
  assert.equal(await worldNft.totalMinted(), 2n, "NFT historical mint count matches controller");
  assert.equal(await worldVault.totalNftWeight(), 2n, "two genesis NFTs begin at weight one");
  assert.equal(await worldVault.unallocatedNftReserve(), 0n, "first minter cannot capture old fees");
  assert.equal(await worldVault.liquidityReserve(), 400_000_000n, "old fees become liquidity reserve");

  const firstOwner = winners[0].address;
  const secondOwner = winners[1].address;
  const firstSigner = signerByAddress.get(firstOwner.toLowerCase());
  const secondSigner = signerByAddress.get(secondOwner.toLowerCase());
  assert.equal(await worldNft.ownerOf(1), firstOwner, "first claimant owns token one");
  assert.equal(await worldNft.ownerOf(2), secondOwner, "second claimant owns token two");

  await (await worldVault.connect(source).depositFee(fee)).wait();
  await (await worldNft.connect(firstSigner).transferFrom(firstOwner, collectorAddress, 1)).wait();
  assert.equal(await worldVault.nftClaimable(firstOwner), 200_000_000n, "pre-transfer rewards stay with old owner");

  await (await worldVault.connect(source).depositFee(fee)).wait();
  await (await worldNft.connect(collector).settleReward(1)).wait();
  await (await worldNft.connect(secondSigner).transferFrom(secondOwner, collectorAddress, 2)).wait();
  assert.equal(await worldVault.nftClaimable(collectorAddress), 200_000_000n, "post-transfer rewards follow NFT");
  assert.equal(await worldVault.nftClaimable(secondOwner), 400_000_000n, "second NFT owner receives both rounds");

  await rejects(() => worldNft.connect(source).fuse(1, 2), "unapproved wallet cannot fuse another owner's NFTs");
  await (await worldNft.connect(collector).fuse(1, 2)).wait();
  const evolved = await worldNft.getBeing(1);
  assert.equal(evolved.weight, 3n, "one plus one Fusion produces weight three");
  assert.equal(evolved.fusionCount, 1n, "Fusion history increments once");
  assert.equal(await worldNft.totalMinted(), 2n, "Fusion never restores mint capacity");
  assert.equal(await worldNft.totalBurned(), 1n, "sacrifice is permanently burned");
  assert.equal(await worldNft.circulatingSupply(), 1n, "live supply decreases after Fusion");
  assert.equal(await worldVault.totalNftWeight(), 3n, "reward weight follows Fusion formula");
  await rejects(() => worldNft.ownerOf(2), "burned sacrifice can never become active again");

  await (await worldVault.connect(source).depositFee(fee)).wait();
  await (await worldNft.connect(collector).settleReward(1)).wait();
  assert.equal(
    await worldVault.nftClaimable(collectorAddress),
    599_999_999n,
    "fused weight receives future rewards except one indivisible index unit",
  );
  assert.equal(await controller.mintedByWallet(firstOwner), 1n, "transfer and Fusion do not restore wallet mint use");
  assert((await worldNft.tokenURI(1)).startsWith("data:application/json;base64,"), "metadata is fully on-chain");

  const expiryEpoch = await nextCommitEpoch(controller, eip1193);
  const expirySecret = ethers.id("expiry-secret");
  const expiryCommitment = await controller.computeCommitment(sourceAddress, expiryEpoch, expirySecret);
  await (await controller.connect(source).commitMint(expiryCommitment)).wait();
  await mineTo(
    eip1193,
    Number(await controller.epochStart(expiryEpoch)) + Number(await controller.commitBlocks()) + 1,
  );
  await (
    await controller.connect(source).revealMint(expiryEpoch, expirySecret, { gasLimit: 500_000 })
  ).wait();
  await mineTo(eip1193, Number(await controller.entropyBlock(expiryEpoch)) + 1);
  await (await controller.finalizeEpoch(expiryEpoch)).wait();
  assert.equal(await controller.totalReserved(), 1n, "unclaimed winner temporarily reserves supply");
  const expiryState = await controller.epochState(expiryEpoch);
  await mineTo(eip1193, Number(expiryState.claimDeadline) + 1);
  await (await controller.expireEpoch(expiryEpoch)).wait();
  assert.equal(await controller.totalReserved(), 0n, "expired unclaimed supply returns to future epochs");

  const lateEpoch = await nextCommitEpoch(controller, eip1193);
  const lateSecret = ethers.id("late-entropy-secret");
  const lateCommitment = await controller.computeCommitment(sourceAddress, lateEpoch, lateSecret);
  await (await controller.connect(source).commitMint(lateCommitment)).wait();
  await mineTo(
    eip1193,
    Number(await controller.epochStart(lateEpoch)) + Number(await controller.commitBlocks()) + 1,
  );
  await (
    await controller.connect(source).revealMint(lateEpoch, lateSecret, { gasLimit: 500_000 })
  ).wait();
  await mineTo(eip1193, Number(await controller.entropyBlock(lateEpoch)) + 257);
  await (await controller.finalizeEpoch(lateEpoch)).wait();
  const lateState = await controller.epochState(lateEpoch);
  assert.equal(lateState.usedLateEntropy, true, "late finalization remains live after blockhash expiry");
  assert.equal(await controller.isWinner(lateEpoch, sourceAddress), true, "single late revealer remains eligible");
  await (await controller.connect(source).claimMint(lateEpoch)).wait();
  assert.equal(await worldNft.totalMinted(), 3n, "late entropy path can still mint normally");
  assert.equal(await controller.totalReserved(), 0n, "late claim consumes its reservation");

  const secondSourceEpoch = await nextCommitEpoch(controller, eip1193);
  const secondSourceSecret = ethers.id("second-source-mint");
  const secondSourceCommitment = await controller.computeCommitment(
    sourceAddress,
    secondSourceEpoch,
    secondSourceSecret,
  );
  await (await controller.connect(source).commitMint(secondSourceCommitment)).wait();
  await mineTo(
    eip1193,
    Number(await controller.epochStart(secondSourceEpoch)) + Number(await controller.commitBlocks()) + 1,
  );
  await (
    await controller
      .connect(source)
      .revealMint(secondSourceEpoch, secondSourceSecret, { gasLimit: 500_000 })
  ).wait();
  await mineTo(eip1193, Number(await controller.entropyBlock(secondSourceEpoch)) + 1);
  await (await controller.finalizeEpoch(secondSourceEpoch)).wait();
  await (await controller.connect(source).claimMint(secondSourceEpoch)).wait();
  assert.equal(await controller.mintedByWallet(sourceAddress), 2n, "wallet may use exactly its two allocations");

  const blockedEpoch = await nextCommitEpoch(controller, eip1193);
  const blockedCommitment = await controller.computeCommitment(
    sourceAddress,
    blockedEpoch,
    ethers.id("third-source-mint"),
  );
  await rejects(
    () => controller.connect(source).commitMint(blockedCommitment),
    "historical wallet limit blocks a third mint",
  );
  assert(
    (await controller.totalMinted()) + (await controller.totalReserved()) <= (await controller.maxSupply()),
    "historical mints plus reservations stay under the immutable cap",
  );

  const capNft = await deploy("MockFairMintNft", factory, [1]);
  const capController = await deploy("FairMintController", factory, [
    await capNft.getAddress(),
    1,
    3,
    3,
    3,
    1,
    1,
  ]);
  const capEpoch = Number(await capController.currentEpoch());
  const capSecret = ethers.id("cap-reservation");
  const capCommitment = await capController.computeCommitment(aliceAddress, capEpoch, capSecret);
  await (await capController.connect(alice).commitMint(capCommitment)).wait();
  await mineTo(
    eip1193,
    Number(await capController.epochStart(capEpoch)) + Number(await capController.commitBlocks()) + 1,
  );
  await (await capController.connect(alice).revealMint(capEpoch, capSecret)).wait();
  await mineTo(eip1193, Number(await capController.entropyBlock(capEpoch)) + 1);
  await (await capController.finalizeEpoch(capEpoch)).wait();
  assert.equal(await capController.totalReserved(), 1n, "the only mint slot is reserved");

  const fullEpoch = await nextCommitEpoch(capController, eip1193);
  const fullCommitment = await capController.computeCommitment(
    bobAddress,
    fullEpoch,
    ethers.id("blocked-while-full"),
  );
  await rejects(
    () => capController.connect(bob).commitMint(fullCommitment),
    "new commitments stop while all mint capacity is reserved",
  );

  const capState = await capController.epochState(capEpoch);
  await mineTo(eip1193, Number(capState.claimDeadline) + 1);
  await (await capController.expireEpoch(capEpoch)).wait();
  assert.equal(await capController.totalReserved(), 0n, "expiry releases the final reserved slot");

  const reopenedEpoch = await nextCommitEpoch(capController, eip1193);
  const reopenedCommitment = await capController.computeCommitment(
    bobAddress,
    reopenedEpoch,
    ethers.id("reopened-after-expiry"),
  );
  await (await capController.connect(bob).commitMint(reopenedCommitment)).wait();
  assert.notEqual(
    await capController.commitments(reopenedEpoch, bobAddress),
    ethers.ZeroHash,
    "commitments resume after stale capacity is released",
  );

  await eip1193.disconnect();
  console.log("Stock World NFT, fair mint, transfer reward, and Fusion tests passed");
}

main().catch((error) => {
  console.error(error.info?.error?.data || error);
  process.exit(1);
});
