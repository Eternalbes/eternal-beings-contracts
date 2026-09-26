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
  const phantomQuote = 1_680_000n;
  const graduationThreshold = 4_200_000n;

  assert.equal(await registry.authority(), authorityAddress, "registry authority is immutable constructor input");
  await assertRejects(
    () => registry.connect(alice).registerQuoteAsset(quoteAddress, phantomQuote, graduationThreshold),
    "non-authority cannot register quote assets",
  );
  await assertRejects(
    () => registry.registerQuoteAsset(aliceAddress, phantomQuote, graduationThreshold),
    "EOA cannot be registered as a quote asset",
  );
  await assertRejects(
    () => registry.registerQuoteAsset(quoteAddress, phantomQuote, graduationThreshold + 10n),
    "quote economics that change the canonical PONS reserve ratio are rejected",
  );

  await (await registry.registerQuoteAsset(quoteAddress, phantomQuote, graduationThreshold)).wait();
  assert.equal(await registry.isSupported(quoteAddress), true, "registered quote asset starts enabled");
  assert.equal(await registry.decimalsOf(quoteAddress), 6n, "quote asset decimals are read from contract");
  assert.deepEqual(
    [...await registry.economicsOf(quoteAddress)],
    [phantomQuote, graduationThreshold],
    "registry fixes PONS-style economics per quote asset",
  );
  assert.deepEqual(
    [...await registry.economicsOf(ethers.ZeroAddress)],
    [ethers.parseEther("1.68"), ethers.parseEther("4.2")],
    "native ETH uses the canonical PONS economics",
  );
  await assertRejects(
    () => registry.registerQuoteAsset(quoteAddress, phantomQuote, graduationThreshold),
    "duplicate registration rejected",
  );

  const validator = await deploy(validatorArtifact, authority, [await registry.getAddress()]);
  const visualSeed = {
    imageHash: ethers.id("alpha-image"),
    vectorHash: ethers.id("alpha-vector"),
    paletteHash: ethers.id("alpha-palette"),
    styleHash: ethers.id("alpha-style"),
    imageURI: `seed://${ethers.id("alpha-image").slice(2)}`,
    renderMode: 1,
  };
  const validConfig = {
    name: "Alpha World",
    symbol: "ALPHA",
    quoteAsset: quoteAddress,
    creator: aliceAddress,
    graduationTarget: graduationThreshold,
    nftMaxSupply: 10_000,
    tokenHolderBps: 4_000,
    nftHolderBps: 4_000,
    creatorBps: 2_000,
    mintConfig: {
      difficulty: 0,
      customSchedule: { commitBlocks: 0, revealBlocks: 0, claimBlocks: 0, epochCapacity: 0, walletLimit: 0 },
    },
    visualSeed,
  };

  const configHash = await validator.validateConfig(validConfig);
  assert.notEqual(configHash, ethers.ZeroHash, "valid configuration returns deterministic hash");
  assert.equal(configHash, await validator.hashConfig(validConfig), "validation and public hash agree");
  assert.equal(await validator.WORLD_TOKEN_SUPPLY(), ethers.parseEther("1000000000"), "PONS fixed token supply exposed");
  assert.equal(await validator.PLATFORM_LAUNCH_FEE(), ethers.parseEther("0.0003"), "launch fee exposed");
  assert.equal(await validator.BASE_TRADING_FEE_BPS(), 100n, "base trading fee is one percent");
  const maxGraduationTarget = await validator.MAX_GRADUATION_TARGET();
  assert.equal(
    maxGraduationTarget,
    (1n << 127n) - 1n,
    "graduation seed amount exposes the signed V4 delta boundary",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, graduationTarget: graduationThreshold + 1n }),
    "creator cannot override protocol graduation economics",
  );

  await assertRejects(
    () => validator.validateConfig({ ...validConfig, nftMaxSupply: 99 }),
    "NFT supply below minimum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, nftMaxSupply: 10_001 }),
    "NFT supply above maximum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({
      ...validConfig,
      mintConfig: { ...validConfig.mintConfig, difficulty: 4 },
    }),
    "unknown Mint difficulty rejected",
  );
  await assertRejects(
    () => validator.validateConfig({
      ...validConfig,
      mintConfig: {
        difficulty: 0,
        customSchedule: { commitBlocks: 300, revealBlocks: 300, claimBlocks: 1_200, epochCapacity: 100, walletLimit: 1 },
      },
    }),
    "preset difficulty cannot hide custom Mint parameters",
  );
  const customConfig = {
    ...validConfig,
    mintConfig: {
      difficulty: 3,
      customSchedule: { commitBlocks: 300, revealBlocks: 600, claimBlocks: 1_200, epochCapacity: 777, walletLimit: 3 },
    },
  };
  assert.notEqual(await validator.validateConfig(customConfig), ethers.ZeroHash, "bounded custom Mint schedule accepted");
  await assertRejects(
    () => validator.validateConfig({
      ...customConfig,
      mintConfig: { ...customConfig.mintConfig, customSchedule: { ...customConfig.mintConfig.customSchedule, commitBlocks: 299 } },
    }),
    "custom commit phase below protocol minimum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({
      ...customConfig,
      mintConfig: { ...customConfig.mintConfig, customSchedule: { ...customConfig.mintConfig.customSchedule, epochCapacity: 10_001 } },
    }),
    "custom epoch capacity above NFT supply rejected",
  );
  await assertRejects(
    () => validator.validateConfig({
      ...customConfig,
      mintConfig: { ...customConfig.mintConfig, customSchedule: { ...customConfig.mintConfig.customSchedule, walletLimit: 11 } },
    }),
    "custom wallet limit above protocol maximum rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, tokenHolderBps: 4_001 }),
    "fee allocation not totaling 100 percent rejected",
  );
  assert.notEqual(
    await validator.validateConfig({
      ...validConfig,
      tokenHolderBps: 1_000,
      nftHolderBps: 1_000,
      creatorBps: 8_000,
    }),
    ethers.ZeroHash,
    "creator allocation at 80 percent accepted",
  );
  await assertRejects(
    () =>
      validator.validateConfig({
        ...validConfig,
        tokenHolderBps: 999,
        nftHolderBps: 1_000,
        creatorBps: 8_001,
      }),
    "creator allocation above 80 percent rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, tokenHolderBps: 0, nftHolderBps: 8_000 }),
    "empty token-holder reward allocation rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, visualSeed: { ...visualSeed, imageHash: ethers.ZeroHash } }),
    "empty visual seed hash rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, visualSeed: { ...visualSeed, renderMode: 2 } }),
    "unknown render mode rejected",
  );
  await assertRejects(
    () => validator.validateConfig({ ...validConfig, visualSeed: { ...visualSeed, imageURI: "seed://bad\"uri" } }),
    "unsafe visual seed URI rejected",
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
  const fixedSupply = ethers.parseEther("1000000000");
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
