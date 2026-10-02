const fs = require("fs");
const assert = require("assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");

const { HISTORY, ARB_SYS, HISTORY_WINDOW, HISTORY_CODE_HASH: CODE_HASH, HISTORY_CODE } = require("./stock-world-block-history");
const WINDOW = BigInt(HISTORY_WINDOW);

async function main() {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai", chainId: 46630 } });
  const provider = new ethers.BrowserProvider(chain);
  const signers = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map((s) => s.getAddress()));
  const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
  const tx = async (promise) => (await promise).wait();
  async function deploy(name, args) {
    const a = artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signers[0]).deploy(...args);
    await c.waitForDeployment();
    return c;
  }
  const setCode = (address, code) => chain.request({ method: "evm_setAccountCode", params: [address, code] });
  const setHash = (number, hash) => chain.request({ method: "evm_setAccountStorageAt", params: [
    HISTORY, ethers.zeroPadValue(ethers.toBeHex(number % WINDOW), 32), hash,
  ] });
  try {
    assert.equal(ethers.keccak256(HISTORY_CODE), CODE_HASH);
    await setCode(ARB_SYS, artifact("MockArbSysBlockClock").deployedBytecode);
    await setCode(HISTORY, HISTORY_CODE);
    const clock = new ethers.Contract(ARB_SYS, artifact("MockArbSysBlockClock").abi, signers[0]);
    await tx(clock.setBlockNumber(2000));
    const nft = await deploy("MockFairMintNft", [20]);
    const nftAddress = await nft.getAddress();
    await assert.rejects(() => deploy("FairMintController", [nftAddress, 20, 30, 40, 237601, 2, 2]));
    const mint = await deploy("FairMintController", [nftAddress, 20, 30, 40, 237600, 2, 2]);
    const target = await mint.entropyBlock(0);
    for (let i = 1; i <= 3; i++) {
      const secret = ethers.id(`history-secret-${i}`);
      await tx(mint.connect(signers[i]).commitMint(await mint.computeCommitment(addresses[i], 0, secret)));
    }
    await tx(clock.setBlockNumber(await mint.startBlock() + 30n));
    for (let i = 1; i <= 3; i++) await tx(mint.connect(signers[i]).revealMint(0, ethers.id(`history-secret-${i}`)));
    const targetHash = ethers.id("canonical-target-hash");
    await setHash(target, targetHash);
    // First ever settlement at the final claim block, with no keeper/capture.
    await tx(clock.setBlockNumber(target + 237600n));
    await assert.rejects(() => clock.arbBlockHash(target), "short precompile history is unavailable");
    assert.equal(await provider.call({ to: HISTORY, data: ethers.zeroPadValue(ethers.toBeHex(target), 32) }), targetHash);
    const state = await mint.epochState(0);
    const seed = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32"], [state.revealEntropy, 0, await mint.getAddress(), targetHash],
    ));
    const start = BigInt(seed) % 3n;
    const winners = [];
    for (let i = 1; i <= 3; i++) {
      if ((BigInt(i - 1) + 3n - start) % 3n < 2n) winners.push(i);
      else await assert.rejects(() => mint.connect(signers[i]).claimMint.staticCall(0));
    }
    assert.equal((await mint.epochState(0)).finalized, false, "loser's revert cannot finalize state");
    await tx(mint.connect(signers[winners[0]]).claimMint(0));
    const settled = await mint.epochState(0);
    assert.equal(settled.usedLateEntropy, false);
    assert.equal(settled.finalSeed, seed, "historical and timely selection use the identical target hash");
    assert.equal(settled.winnerCount, 2n);
    assert.equal(settled.claimDeadline, target + 237600n);
    await tx(mint.connect(signers[winners[1]]).claimMint(0));
    assert.equal(await nft.totalMinted(), 2n);
    assert.equal(await mint.totalReserved(), 0n);
    await assert.rejects(() => mint.connect(signers[winners[0]]).claimMint.staticCall(0), "duplicate claim rejected");
    await tx(clock.setBlockNumber(target + WINDOW));
    assert.equal(await provider.call({ to: HISTORY, data: ethers.zeroPadValue(ethers.toBeHex(target), 32) }), targetHash);
    await tx(clock.setBlockNumber(target + WINDOW + 1n));
    await assert.rejects(() => provider.call({ to: HISTORY, data: ethers.zeroPadValue(ethers.toBeHex(target), 32) }));

    // An address lookalike returning attacker entropy is not a valid history source.
    await tx(clock.setBlockNumber(400000));
    const expired = await deploy("FairMintController", [await nft.getAddress(), 20, 30, 40, 237600, 2, 2]);
    const expiredTarget = await expired.entropyBlock(0);
    for (let i = 1; i <= 3; i++) await tx(expired.connect(signers[i]).commitMint(
      await expired.computeCommitment(addresses[i], 0, ethers.id(`expired-${i}`)),
    ));
    await tx(clock.setBlockNumber(await expired.startBlock() + 30n));
    for (let i = 1; i <= 3; i++) await tx(expired.connect(signers[i]).revealMint(0, ethers.id(`expired-${i}`)));
    await setHash(expiredTarget, ethers.id("expired-target-hash"));
    await tx(clock.setBlockNumber(expiredTarget + 237601n));
    await assert.rejects(() => expired.connect(signers[1]).claimMint.staticCall(0));
    await tx(expired.finalizeEpoch(0));
    assert.equal((await expired.epochState(0)).expired, true, "history cannot reopen the Claim deadline");
    assert.equal(await expired.totalReserved(), 0n);
    const badNft = await deploy("MockFairMintNft", [20]);
    const badNftAddress = await badNft.getAddress();
    const bad = await deploy("FairMintController", [badNftAddress, 20, 30, 40, 237600, 1, 2]);
    const badTarget = await bad.entropyBlock(0);
    for (let i = 1; i <= 2; i++) await tx(bad.connect(signers[i]).commitMint(
      await bad.computeCommitment(addresses[i], 0, ethers.id(`bad-${i}`)),
    ));
    await tx(clock.setBlockNumber(await bad.startBlock() + 30n));
    for (let i = 1; i <= 2; i++) await tx(bad.connect(signers[i]).revealMint(0, ethers.id(`bad-${i}`)));
    await setCode(HISTORY, `0x7f${ethers.id("forged-history").slice(2)}60005260206000f3`);
    await assert.rejects(() => deploy("FairMintController", [badNftAddress, 20, 30, 40, 237600, 1, 2]),
      "Robinhood deployment requires the canonical history runtime");
    await tx(clock.setBlockNumber(badTarget + 1000n));
    await assert.rejects(() => bad.connect(signers[1]).claimMint.staticCall(0));
    await tx(bad.finalizeEpoch(0));
    assert.equal((await bad.epochState(0)).expired, true);
    assert.equal((await bad.epochState(0)).finalSeed, ethers.ZeroHash);
    assert.equal(await bad.totalReserved(), 0n);
    console.log("Stock World block history passed: full-window delayed lottery, exact winners, identical seed, boundaries, code pinning, duplicate rejection");
  } finally {
    provider.destroy();
    await chain.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
