const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function artifact(name) {
  return JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
}

async function deploy(name, signer, args = []) {
  const item = artifact(name);
  const contract = await new ethers.ContractFactory(item.abi, item.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function rejects(action, message) {
  let failed = false;
  try {
    const result = await action();
    if (result?.wait) await result.wait();
  } catch (_) {
    failed = true;
  }
  assert(failed, message);
}

async function deadline(provider) {
  return BigInt((await provider.getBlock("latest")).timestamp + 3_600);
}

async function balance(provider, account) {
  return BigInt(await provider.send("eth_getBalance", [account, "latest"]));
}

async function main() {
  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const [factory, creator, buyer, sellerRecipient, rewardRecipient] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
  );
  const [factoryAddress, creatorAddress, buyerAddress, sellerRecipientAddress, rewardRecipientAddress] =
    await Promise.all([factory, creator, buyer, sellerRecipient, rewardRecipient].map((signer) => signer.getAddress()));

  const registry = await deploy("QuoteAssetRegistry", factory, [factoryAddress]);
  const validator = await deploy("StockWorldConfigValidator", factory, [await registry.getAddress()]);
  const nativeConfig = {
    name: "Ether World",
    symbol: "ETHER",
    quoteAsset: ethers.ZeroAddress,
    creator: creatorAddress,
    graduationTarget: ethers.parseEther("9"),
    nftMaxSupply: 1_000,
    tokenHolderBps: 4_000,
    nftHolderBps: 4_000,
    creatorBps: 2_000,
  };
  assert.notEqual(await validator.validateConfig(nativeConfig), ethers.ZeroHash, "native ETH is a canonical quote without registry enrollment");

  const token = await deploy("WorldToken", factory, [nativeConfig.name, nativeConfig.symbol, factoryAddress]);
  const tokenAddress = await token.getAddress();
  const tokenVault = await deploy("TokenRewardVault", factory, [tokenAddress, ethers.ZeroAddress]);
  const worldVault = await deploy("WorldRewardVault", factory, [
    ethers.ZeroAddress,
    await tokenVault.getAddress(),
    factoryAddress,
    creatorAddress,
    nativeConfig.tokenHolderBps,
    nativeConfig.nftHolderBps,
    nativeConfig.creatorBps,
  ]);
  const curve = await deploy("StockWorldBondingCurve", factory, [
    ethers.ZeroAddress,
    await worldVault.getAddress(),
    factoryAddress,
    ethers.parseEther("1"),
    nativeConfig.graduationTarget,
  ]);
  const curveAddress = await curve.getAddress();
  await (await token.transfer(curveAddress, await token.totalSupply())).wait();
  await (await curve.initialize(tokenAddress)).wait();

  const quoteIn = ethers.parseEther("0.25");
  const preview = await curve.previewBuy(quoteIn);
  const firstDeadline = await deadline(provider);
  await rejects(
    () => curve.connect(buyer).buy(quoteIn, preview.tokensOut, buyerAddress, firstDeadline, { value: quoteIn - 1n }),
    "native buy rejects a mismatched msg.value",
  );
  await (
    await curve.connect(buyer).buy(quoteIn, preview.tokensOut, buyerAddress, await deadline(provider), { value: quoteIn })
  ).wait();
  assert.equal(await token.balanceOf(buyerAddress), preview.tokensOut, "native ETH buys World Tokens without approval");
  assert.equal(await worldVault.totalFeesDeposited(), preview.fee, "native trading fee reaches the reward vault");

  const sellAmount = preview.tokensOut / 4n;
  await (await token.connect(buyer).approve(curveAddress, sellAmount)).wait();
  const sellPreview = await curve.previewSell(sellAmount);
  const recipientBefore = await balance(provider, sellerRecipientAddress);
  await (
    await curve.connect(buyer).sell(sellAmount, sellPreview.quoteOut, sellerRecipientAddress, await deadline(provider))
  ).wait();
  assert.equal(
    (await balance(provider, sellerRecipientAddress)) - recipientBefore,
    sellPreview.quoteOut,
    "native ETH sell proceeds reach the selected recipient",
  );

  const stake = (await token.balanceOf(buyerAddress)) / 2n;
  await (await token.connect(buyer).approve(await tokenVault.getAddress(), stake)).wait();
  await (await tokenVault.connect(buyer).queueStake(stake)).wait();
  await eip1193.request({ method: "evm_mine", params: [] });
  await (await tokenVault.connect(buyer).activateStake()).wait();

  const secondQuote = ethers.parseEther("0.1");
  const secondPreview = await curve.previewBuy(secondQuote);
  await (
    await curve.connect(creator).buy(secondQuote, secondPreview.tokensOut, creatorAddress, await deadline(provider), { value: secondQuote })
  ).wait();
  const pending = await tokenVault.pendingRewards(buyerAddress);
  assert(pending > 0n, "active World Token stake accrues native ETH fees");
  const rewardBefore = await balance(provider, rewardRecipientAddress);
  await (await tokenVault.connect(buyer).claim(rewardRecipientAddress)).wait();
  assert.equal(
    (await balance(provider, rewardRecipientAddress)) - rewardBefore,
    pending,
    "native ETH staking reward is paid exactly",
  );

  await eip1193.disconnect();
  console.log("Stock World native ETH quote tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
