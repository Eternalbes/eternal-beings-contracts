const fs = require("fs");
const { ethers } = require("ethers");

const [
  rpcUrl,
  gameAddress,
  claimReportPath = "reports/sepolia-fast-v4-3-wallet-batch-test-mint.json",
  secretsPath = "reports/secrets/sepolia-fast-v4-3-wallet-batch-test-mint.secrets.json",
  outputPath = "reports/sepolia-fast-v4-marketplace-compat-test.json",
] = process.argv.slice(2);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/sepolia-marketplace-compat-test.js <rpcUrl> <gameAddress> [claimReport] [secretsPath] [outputPath]",
    ].join("\n"),
  );
}

function readJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function decodeDataUri(uri, mimeType) {
  const base64Prefix = `data:${mimeType};base64,`;
  if (uri.startsWith(base64Prefix)) return Buffer.from(uri.slice(base64Prefix.length), "base64").toString("utf8");
  const utf8Prefix = `data:${mimeType};utf8,`;
  if (uri.startsWith(utf8Prefix)) return decodeURIComponent(uri.slice(utf8Prefix.length));
  throw new Error(`unexpected ${mimeType} URI prefix: ${uri.slice(0, 80)}`);
}

function secretForAddress(secretReport, address) {
  const lower = address.toLowerCase();
  const match = (secretReport.wallets || []).find((wallet) => String(wallet.address).toLowerCase() === lower);
  if (!match || !match.privateKey) throw new Error(`missing private key for ${address}`);
  return match.privateKey;
}

async function optionalStatic(label, fn) {
  try {
    return { label, ok: true, value: await fn() };
  } catch (error) {
    return { label, ok: false, error: error.shortMessage || error.reason || error.message };
  }
}

async function main() {
  if (!rpcUrl || !gameAddress) {
    usage();
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const gameRead = new ethers.Contract(gameAddress, artifact.abi, provider);
  const claimReport = readJson(claimReportPath);
  const secrets = readJson(secretsPath);
  const liveClaims = [];
  for (const claim of claimReport.claims || []) {
    if (!claim.ok || !claim.tokenId) continue;
    try {
      const owner = await gameRead.ownerOf(BigInt(claim.tokenId));
      liveClaims.push({ ...claim, owner });
    } catch {
      // Burned tokens are useful for negative metadata checks, but not for transfer tests.
    }
  }
  if (liveClaims.length < 1) throw new Error("need at least 1 live claimed token");

  const source = liveClaims[0];
  const target = (claimReport.claims || []).find(
    (claim) => claim.ok && claim.address.toLowerCase() !== source.address.toLowerCase(),
  );
  if (!target) throw new Error("need a secondary wallet for transfer compatibility test");
  const sourceWallet = new ethers.Wallet(secretForAddress(secrets, source.address), provider);
  const targetWallet = new ethers.Wallet(secretForAddress(secrets, target.address), provider);
  const game = gameRead.connect(sourceWallet);
  const tokenId = BigInt(source.tokenId);

  const interfaces = {
    erc165: await gameRead.supportsInterface("0x01ffc9a7"),
    erc721: await gameRead.supportsInterface("0x80ac58cd"),
    erc721Metadata: await gameRead.supportsInterface("0x5b5e139f"),
    erc2981: await gameRead.supportsInterface("0x2a55205a"),
    erc4906: await gameRead.supportsInterface("0x49064906"),
    enumerable: await gameRead.supportsInterface("0x780e9d63"),
  };

  const [name, symbol, balanceBefore, ownerBefore, approvedBefore, royaltyOneEth, royaltySmall] = await Promise.all([
    gameRead.name(),
    gameRead.symbol(),
    gameRead.balanceOf(sourceWallet.address),
    gameRead.ownerOf(tokenId),
    gameRead.getApproved(tokenId),
    gameRead.royaltyInfo(tokenId, ethers.parseEther("1")),
    gameRead.royaltyInfo(tokenId, 12345n),
  ]);

  const tokenURI = await gameRead.tokenURI(tokenId);
  const metadata = JSON.parse(decodeDataUri(tokenURI, "application/json"));
  const svg = decodeDataUri(metadata.image, "image/svg+xml");
  const transferTx = await game.transferFrom(sourceWallet.address, targetWallet.address, tokenId, { gasLimit: 140000n });
  const transferReceipt = await transferTx.wait();
  const ownerAfterTransfer = await gameRead.ownerOf(tokenId);
  const returnTx = await gameRead.connect(targetWallet).transferFrom(targetWallet.address, sourceWallet.address, tokenId, {
    gasLimit: 140000n,
  });
  const returnReceipt = await returnTx.wait();
  const ownerAfterReturn = await gameRead.ownerOf(tokenId);

  const invalidTokenId = 1000000n;
  const negative = [
    await optionalStatic("tokenURI invalid token should revert", () => gameRead.tokenURI(invalidTokenId)),
    await optionalStatic("ownerOf invalid token should revert", () => gameRead.ownerOf(invalidTokenId)),
    await optionalStatic("balanceOf zero address should revert", () => gameRead.balanceOf(ethers.ZeroAddress)),
  ];

  const report = {
    createdAt: new Date().toISOString(),
    gameAddress,
    tokenId: tokenId.toString(),
    name,
    symbol,
    interfaces,
    enumerableIntentionallyUnsupported: interfaces.enumerable === false,
    royalty: {
      oneEth: {
        receiver: royaltyOneEth[0],
        amount: royaltyOneEth[1].toString(),
      },
      smallSale: {
        receiver: royaltySmall[0],
        amount: royaltySmall[1].toString(),
      },
    },
    metadata: {
      tokenURIBytes: Buffer.byteLength(tokenURI, "utf8"),
      tokenURIPrefix: tokenURI.slice(0, 29),
      name: metadata.name,
      descriptionBytes: Buffer.byteLength(metadata.description || "", "utf8"),
      imagePrefix: String(metadata.image || "").slice(0, 30),
      svgBytes: Buffer.byteLength(svg, "utf8"),
      svgStartsWithSvgTag: svg.trimStart().startsWith("<svg"),
      attributes: Array.isArray(metadata.attributes) ? metadata.attributes.length : 0,
      attributeNames: Array.isArray(metadata.attributes) ? metadata.attributes.map((attr) => attr.trait_type) : [],
    },
    ownership: {
      source: sourceWallet.address,
      target: targetWallet.address,
      balanceBefore: balanceBefore.toString(),
      ownerBefore,
      approvedBefore,
      transfer: {
        tx: transferReceipt.hash,
        blockNumber: transferReceipt.blockNumber,
        gasUsed: transferReceipt.gasUsed.toString(),
      },
      ownerAfterTransfer,
      returnTransfer: {
        tx: returnReceipt.hash,
        blockNumber: returnReceipt.blockNumber,
        gasUsed: returnReceipt.gasUsed.toString(),
      },
      ownerAfterReturn,
    },
    negative,
    ok:
      interfaces.erc165 &&
      interfaces.erc721 &&
      interfaces.erc721Metadata &&
      interfaces.erc2981 &&
      interfaces.erc4906 &&
      !interfaces.enumerable &&
      royaltyOneEth[1] === ethers.parseEther("0.03") &&
      tokenURI.startsWith("data:application/json;base64,") &&
      String(metadata.image || "").startsWith("data:image/svg+xml;base64,") &&
      Array.isArray(metadata.attributes) &&
      metadata.attributes.length >= 9 &&
      ownerAfterTransfer.toLowerCase() === targetWallet.address.toLowerCase() &&
      ownerAfterReturn.toLowerCase() === sourceWallet.address.toLowerCase() &&
      negative.every((item) => !item.ok),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
