const fs = require("fs");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { buildTree } = require("./merkle");

const collectionPath = process.argv[2] || "data/top-collections.ethereum.curated.json";
const royaltyReceiver = process.argv[3] || ethers.ZeroAddress;
const outPath = process.argv[4] || "";

async function estimateDeployGas(root, receiver) {
  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const signer = await provider.getSigner(0);
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, signer);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const deployReceiver = receiver === ethers.ZeroAddress ? await signer.getAddress() : receiver;
  const renderer = await rendererFactory.deploy();
  const rendererReceipt = await renderer.deploymentTransaction().wait();
  const contract = await factory.deploy(root, deployReceiver, await renderer.getAddress());
  const receipt = await contract.deploymentTransaction().wait();
  return {
    rendererGasUsed: rendererReceipt.gasUsed.toString(),
    gameGasUsed: receipt.gasUsed.toString(),
    totalGasUsed: (rendererReceipt.gasUsed + receipt.gasUsed).toString(),
    rendererAddress: await renderer.getAddress(),
    measuredWithReceiver: deployReceiver,
  };
}

function bytesOfArtifact(name) {
  const artifact = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, "utf8"));
  return {
    creationBytes: (artifact.bytecode.length - 2) / 2,
    runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
  };
}

async function main() {
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const collections = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
  const tree = buildTree(collections);
  const tiers = {};
  for (const entry of collections) {
    tiers[entry.tier] = (tiers[entry.tier] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    collectionPath,
    constructorArgs: {
      topCollectionsRoot: tree.root,
      royaltyReceiver,
      rendererAddress: "deploy EternalRenderer first, then pass its address",
    },
    collectionSummary: {
      entries: collections.length,
      tiers,
      cryptoPunksAdapter: collections.some((entry) => entry.name === "CryptoPunks"),
      removedLegacyReviewItems: {
        cryptoKitties: !collections.some((entry) => entry.name === "CryptoKitties"),
        autoglyphs: !collections.some((entry) => entry.name === "Autoglyphs"),
        knownOrigin: !collections.some((entry) => entry.name === "KnownOrigin"),
      },
    },
    bytecode: {
      EternalBeings: bytesOfArtifact("EternalBeings"),
      EternalOre: bytesOfArtifact("EternalOre"),
      EternalRenderer: bytesOfArtifact("EternalRenderer"),
      eip170RuntimeLimitBytes: 24576,
    },
    deploymentGasEstimate: await estimateDeployGas(tree.root, royaltyReceiver),
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, `${json}\n`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
