const assert = require("assert");
const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");

function loadArtifact(name) {
  const path = `artifacts/${name}.json`;
  if (!fs.existsSync(path)) throw new Error(`Missing ${path}; compile with WRITE_ARTIFACTS=1 first`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
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

async function deploy(artifact, signer, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const registryArtifact = loadArtifact("QuoteAssetRegistry");
  const validatorArtifact = loadArtifact("StockWorldConfigValidator");
  const tokenArtifact = loadArtifact("WorldToken");
  const quoteArtifact = loadArtifact("MockQuoteAsset");

  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [authority, alice, bob, spender] = await Promise.all([
    provider.getSigner(0),
    provider.getSigner(1),
    provider.getSigner(2),
    provider.getSigner(3),
  ]);

  const authorityAddress = await authority.getAddress();
  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();
  const spenderAddress = await spender.getAddress();

  const registry = await deploy(registryArtifact, authority, [authorityAddress]);
  const quote = await deploy(quoteArtifact, authority, ["Mock USD", "mUSD", 6]);
  const quoteAddress = await quote.getAddress();

  assert.equal(await registry.authority(), authorityAddress, "registry authority is immutable constructor input");
  await assertRejects(
    () => registry.connect(alice).registerQuoteAsset(quoteAddress),
    "non-authority cannot register quote assets",
  );
  await assertRejects(
    () => registry.registerQuoteAsset(aliceAddress),
    "EOA cannot be registered as a quote asset",
  );

  await (await registry.registerQuoteAsset(quoteAddress)).wait();
  assert.equal(await registry.isSupported(quoteAddress), true, "registered quote asset starts enabled");
  assert.equal(await registry.decimalsOf(quoteAddress), 6n, "quote asset decimals are read from contract");
  await assertRejects(() => registry.registerQuoteAsset(quoteAddress), "duplicate registration rejected");

  const validator = await deploy(validatorArtifact, authority, [await registry.getAddress()]);
  const validConfig = {
    name: "Alpha World",
    symbol: "ALPHA",
    quoteAsset: quoteAddress,
    creator: aliceAddress,
    graduationTarget: 1_000_000_000n,
    nftMaxSupply: 10_000,
    tokenHolderBps: 4_000,
    nftHolderBps: 4_000,
    creatorBps: 2_000,
  };

  const configHash = await validator.validateConfig(validConfig);
  assert.notEqual(configHash, ethers.ZeroHash, "valid configuration returns deterministic hash");
  assert.equal(configHash, await validator.hashConfig(validConfig), "validation and public hash agree");
  assert.equal(await validator.WORLD_TOKEN_SUPPLY(), ethers.parseEther("1000000"), "fixed token supply exposed");
  assert.equal(await validator.PLATFORM_LAUNCH_FEE(), ethers.parseEther("0.0003"), "launch fee exposed");
  assert.equal(await validator.BASE_TRADING_FEE_BPS(), 100n, "base trading fee is one percent");

  await assertRejects(
    () => validator.validateConfig({ ...validConfig, nftMaxSupply: 99 }),
    "NFT supply below minimum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, nftMaxSupply: 10_001 }),
    "NFT supply above maximum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, tokenHolderBps: 4_001 }),
    "fee allocation not totaling 100 percent rejected",
  );
  await assertRejects(
    () =>
      validator.validateConfig({
        ...validConfig,
        tokenHolderBps: 3_000,
        nftHolderBps: 3_000,
        creatorBps: 4_000,
      }),
    "creator allocation above 30 percent rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, tokenHolderBps: 0, nftHolderBps: 8_000 }),
    "empty token-holder reward allocation rejected",
  );

  await (await registry.setQuoteAssetEnabled(quoteAddress, false)).wait();
  assert.equal(await registry.isSupported(quoteAddress), false, "authority may disable an asset for future launches");
  await assertRejects(
    () => validator.validateConfig(validConfig),
    "disabled quote asset rejected by launch validation",
  );
  await assertRejects(
    () => registry.connect(alice).setQuoteAssetEnabled(quoteAddress, true),
    "non-authority cannot re-enable quote assets",
  );
  await (await registry.setQuoteAssetEnabled(quoteAddress, true)).wait();

  const token = await deploy(tokenArtifact, authority, [validConfig.name, validConfig.symbol, aliceAddress]);
  const fixedSupply = ethers.parseEther("1000000");
  assert.equal(await token.name(), validConfig.name, "token name set at construction");
  assert.equal(await token.symbol(), validConfig.symbol, "token symbol set at construction");
  assert.equal(await token.decimals(), 18n, "token uses 18 decimals");
  assert.equal(await token.totalSupply(), fixedSupply, "token supply is fixed");
  assert.equal(await token.balanceOf(aliceAddress), fixedSupply, "entire supply assigned once at construction");

  const transferAmount = ethers.parseEther("125");
  await (await token.connect(alice).transfer(bobAddress, transferAmount)).wait();
  assert.equal(await token.balanceOf(bobAddress), transferAmount, "direct transfer succeeds");

  await (await token.connect(alice).approve(spenderAddress, ethers.parseEther("50"))).wait();
  await (await token.connect(spender).transferFrom(aliceAddress, bobAddress, ethers.parseEther("20"))).wait();
  assert.equal(
    await token.allowance(aliceAddress, spenderAddress),
    ethers.parseEther("30"),
    "finite allowance decreases",
  );

  await (await token.connect(alice).approve(spenderAddress, ethers.MaxUint256)).wait();
  await (await token.connect(spender).transferFrom(aliceAddress, bobAddress, 1n)).wait();
  assert.equal(
    await token.allowance(aliceAddress, spenderAddress),
    ethers.MaxUint256,
    "infinite allowance is preserved",
  );
  await assertRejects(() => token.connect(alice).transfer(ethers.ZeroAddress, 1n), "zero-address transfer rejected");
  await assertRejects(
    () => token.connect(spender).transferFrom(ethers.ZeroAddress, bobAddress, 0n),
    "zero-address transfer source rejected",
  );
  await assertRejects(
    () => token.connect(bob).transfer(aliceAddress, fixedSupply),
    "transfer above balance rejected",
  );

  const functionNames = new Set(
    tokenArtifact.abi.filter((entry) => entry.type === "function").map((entry) => entry.name),
  );
  for (const forbidden of ["mint", "pause", "freeze", "blacklist", "upgradeTo", "owner"]) {
    assert.equal(functionNames.has(forbidden), false, `WorldToken must not expose ${forbidden}()`);
  }

  await eip1193.disconnect();
  console.log("Stock World foundation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
