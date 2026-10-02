const fs = require("fs");
const assert = require("assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { exerciseLottery } = require("./stock-world-testnet-lottery-smoke");
const { HISTORY, HISTORY_WINDOW, installLocalBlockClock } = require("./stock-world-block-history");

async function main() {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { chainId: 46630, hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(chain, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const signers = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
  async function deploy(name, args = []) {
    const item = artifact(name);
    const contract = await new ethers.ContractFactory(item.abi, item.bytecode, signers[0]).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  try {
    await installLocalBlockClock(chain);
    const primary = signers[0].address;
    const token = await deploy("WorldToken", ["Lottery Token", "LT", primary]);
    const tokenVault = await deploy("TokenRewardVault", [await token.getAddress(), ethers.ZeroAddress]);
    const vault = await deploy("WorldRewardVault", [ethers.ZeroAddress, await tokenVault.getAddress(), primary, primary, 4500, 4500, 1000]);
    const renderer = await deploy("StockWorldRenderer");
    const image = ethers.id("local-history-lottery");
    const nft = await deploy("WorldNFT", ["Lottery Beings", "LB", 100, primary, await vault.getAddress(),
      await renderer.getAddress(), [image, image, image, image, `seed://${image.slice(2)}`, 1]]);
    const mint = await deploy("FairMintController", [await nft.getAddress(), 100, 300, 300, 1200, 1, 1]);
    const modules = await deploy("MockWorldModules", [await vault.getAddress()]);
    await (await nft.setMintController(await mint.getAddress())).wait();
    await (await vault.bindWorldModules(await nft.getAddress(), await modules.getAddress())).wait();
    const report = { transactions: [] };
    const privateState = {};
    const receipts = new Map();
    let nonceBeforeResume;
    const send = async (label, wallet, method, parameters) => {
      if (receipts.has(label)) return receipts.get(label);
      const receipt = await (await method(...parameters)).wait();
      receipts.set(label, receipt);
      report.transactions.push({ label, hash: receipt.hash });
      return receipt;
    };
    const target = await mint.entropyBlock(0);
    let recorded = false;
    const waitBlock = async (destination) => {
      while (BigInt(await chain.request({ method: "eth_blockNumber", params: [] })) < destination) {
        await chain.request({ method: "evm_mine", params: [] });
        const current = BigInt(await chain.request({ method: "eth_blockNumber", params: [] }));
        if (!recorded && current >= target) {
          const header = await provider.getBlock(Number(target));
          await chain.request({ method: "evm_setAccountStorageAt", params: [HISTORY,
            ethers.zeroPadValue(ethers.toBeHex(target % BigInt(HISTORY_WINDOW)), 32), header.hash] });
          recorded = true;
        }
      }
    };
    const parameters = { provider, mint, nft, wallets: signers, privateState, savePrivate: () => {},
      report, checkpoint: () => {}, send, waitBlock };
    await exerciseLottery(parameters);
    assert.equal(report.transactions.length, 7);
    assert.equal(report.result.winners, 1);
    assert(report.result.delayBlocks > 256n);
    nonceBeforeResume = await provider.getTransactionCount(primary);
    await exerciseLottery(parameters);
    assert.equal(await provider.getTransactionCount(primary), nonceBeforeResume);
    assert.equal(report.transactions.length, 7);
    assert.equal(await nft.totalMinted(), 1n);
    console.log("Delayed lottery smoke passed locally: 3 revealers / 1 slot, first Claim after 600 blocks, exact seed, losers and duplicate rejected, resume without writes.");
  } finally { provider.destroy(); await chain.disconnect(); }
}

main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
