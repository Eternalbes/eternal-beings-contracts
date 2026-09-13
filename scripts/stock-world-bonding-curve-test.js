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

async function deadline(provider) {
  const block = await provider.getBlock("latest");
  return BigInt(block.timestamp + 3_600);
}

async function main() {
  const eip1193 = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new ethers.BrowserProvider(eip1193);
  const [factory, creator, alice, source, graduationRecipient] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
  );
  const [factoryAddress, creatorAddress, aliceAddress, sourceAddress, graduationAddress] = await Promise.all(
    [factory, creator, alice, source, graduationRecipient].map((signer) => signer.getAddress()),
  );

  const quote = await deploy("MockQuoteAsset", factory, ["Mock USD", "mUSD", 6]);
  const token = await deploy("WorldToken", factory, ["Curve World", "CURVE", factoryAddress]);
  const tokenAddress = await token.getAddress();
  const tokenVault = await deploy("TokenRewardVault", factory, [tokenAddress, await quote.getAddress()]);
  const worldVault = await deploy("WorldRewardVault", factory, [
    await quote.getAddress(),
    await tokenVault.getAddress(),
    factoryAddress,
    creatorAddress,
    4_000,
    4_000,
    2_000,
  ]);

  const virtualQuote = 100_000_000n;
  const graduationTarget = 900_000_000n;
  const curve = await deploy("StockWorldBondingCurve", factory, [
    await quote.getAddress(),
    await worldVault.getAddress(),
    factoryAddress,
    virtualQuote,
    graduationTarget,
  ]);
  const curveAddress = await curve.getAddress();

  await rejects(() => curve.connect(alice).initialize(tokenAddress), "only factory may initialize");
  await (await token.transfer(curveAddress, await token.totalSupply())).wait();
  await (await curve.initialize(tokenAddress)).wait();

  const supply = await token.totalSupply();
  assert.equal(await curve.phase(), 1n, "curve starts live after initialization");
  assert.equal(await curve.trackedTokenReserve(), supply, "entire fixed supply is tracked");
  assert.equal(await curve.reservedTokens(), ethers.parseEther("100000"), "graduation allocation is reserved");
  assert.equal(await curve.sellableTokens(), ethers.parseEther("900000"), "only market allocation is sellable");
  await rejects(() => curve.initialize(tokenAddress), "curve initialization is one-time");

  const initialQuote = 20_000_000_000n;
  await (await quote.mint(sourceAddress, initialQuote)).wait();
  await (await quote.connect(source).approve(curveAddress, initialQuote)).wait();

  const firstQuoteIn = 100_000_000n;
  const firstPreview = await curve.previewBuy(firstQuoteIn);
  const sourceBeforeFirst = await quote.balanceOf(sourceAddress);
  await (
    await curve.connect(source).buy(firstQuoteIn, firstPreview.tokensOut, aliceAddress, await deadline(provider))
  ).wait();
  assert.equal(
    sourceBeforeFirst - (await quote.balanceOf(sourceAddress)),
    firstPreview.quoteSpent,
    "buyer pays the previewed amount",
  );
  assert.equal(await token.balanceOf(aliceAddress), firstPreview.tokensOut, "buyer receives launch tokens");
  assert.equal(await curve.trackedQuoteReserve(), firstPreview.quoteSpent - firstPreview.fee, "fees excluded from price reserve");
  assert.equal(await worldVault.totalFeesDeposited(), firstPreview.fee, "quote-leg fee reaches reward vault");

  const comparisonQuote = 10_000_000n;
  const previewBeforeDonation = await curve.previewBuy(comparisonQuote);
  const quoteDonation = 1_000_000n;
  const tokenDonation = ethers.parseEther("1");
  await (await quote.connect(source).transfer(curveAddress, quoteDonation)).wait();
  await (await token.connect(alice).transfer(curveAddress, tokenDonation)).wait();
  const previewAfterDonation = await curve.previewBuy(comparisonQuote);
  assert.deepEqual(
    [...previewAfterDonation].map(BigInt),
    [...previewBeforeDonation].map(BigInt),
    "forced quote and token transfers cannot move curve pricing",
  );
  assert.equal(await curve.surplusQuote(), quoteDonation, "untracked quote is visible as surplus");
  assert.equal(await curve.surplusTokens(), tokenDonation, "untracked token is visible as surplus");

  const sellAmount = firstPreview.tokensOut / 4n;
  await (await token.connect(alice).approve(curveAddress, sellAmount)).wait();
  const sellPreview = await curve.previewSell(sellAmount);
  const aliceQuoteBefore = await quote.balanceOf(aliceAddress);
  await (
    await curve.connect(alice).sell(sellAmount, sellPreview.quoteOut, aliceAddress, await deadline(provider))
  ).wait();
  assert.equal(
    (await quote.balanceOf(aliceAddress)) - aliceQuoteBefore,
    sellPreview.quoteOut,
    "seller receives previewed net quote",
  );
  const slippageSellAmount = sellAmount / 2n;
  await (await token.connect(alice).approve(curveAddress, slippageSellAmount)).wait();
  const slippageSellPreview = await curve.previewSell(slippageSellAmount);
  await rejects(
    async () =>
      curve
        .connect(alice)
        .sell(slippageSellAmount, slippageSellPreview.quoteOut + 1n, aliceAddress, await deadline(provider)),
    "sell slippage bound is enforced",
  );
  await rejects(
    async () => curve.connect(source).buy(99, 1, sourceAddress, await deadline(provider)),
    "trades cannot split below the minimum fee unit",
  );
  await rejects(
    () => curve.connect(source).buy(comparisonQuote, 1, sourceAddress, 1),
    "expired trade deadline is rejected",
  );

  const finalQuoteOffer = 5_000_000_000n;
  const finalPreview = await curve.previewBuy(finalQuoteOffer);
  assert(finalPreview.refund > 0n, "final buy is quoted as a partial fill");
  const sourceBeforeFinal = await quote.balanceOf(sourceAddress);
  await (
    await curve.connect(source).buy(finalQuoteOffer, finalPreview.tokensOut, sourceAddress, await deadline(provider))
  ).wait();
  assert.equal(await curve.phase(), 2n, "crossing buy moves curve to graduation-ready phase");
  assert.equal(await curve.sellableTokens(), 0n, "reserved graduation allocation cannot be sold");
  assert.equal(
    sourceBeforeFinal - (await quote.balanceOf(sourceAddress)),
    finalPreview.quoteSpent,
    "unspent final-buy quote is refunded",
  );
  await rejects(
    async () => curve.connect(alice).sell(1, 1, aliceAddress, await deadline(provider)),
    "sells close as soon as graduation is ready",
  );
  await rejects(
    () => curve.connect(alice).sweepForGraduation(graduationAddress),
    "only factory may sweep graduation reserves",
  );

  const [quoteToSweep, tokensToSweep] = await curve.sweepForGraduation.staticCall(graduationAddress);
  const recipientQuoteBefore = await quote.balanceOf(graduationAddress);
  const recipientTokenBefore = await token.balanceOf(graduationAddress);
  await (await curve.sweepForGraduation(graduationAddress)).wait();
  assert.equal(await curve.phase(), 3n, "graduation sweep is irreversible");
  assert.equal(
    (await quote.balanceOf(graduationAddress)) - recipientQuoteBefore,
    quoteToSweep,
    "only tracked quote reserve is swept",
  );
  assert.equal(
    (await token.balanceOf(graduationAddress)) - recipientTokenBefore,
    tokensToSweep,
    "only tracked token reserve is swept",
  );
  assert.equal(await quote.balanceOf(curveAddress), quoteDonation, "forced quote remains outside graduation");
  assert.equal(await token.balanceOf(curveAddress), tokenDonation, "forced tokens remain outside graduation");
  assert.equal(await curve.totalQuoteFees(), await worldVault.totalFeesDeposited(), "every curve fee was deposited");

  const feeTotal = await worldVault.totalFeesDeposited();
  const accountedFees =
    (await worldVault.unallocatedTokenReserve()) +
    (await worldVault.unallocatedNftReserve()) +
    (await worldVault.creatorClaimable()) +
    (await worldVault.liquidityReserve());
  assert.equal(accountedFees, feeTotal, "reward vault conserves all curve fees including rounding");

  await eip1193.disconnect();
  console.log("Stock World bonding curve tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
