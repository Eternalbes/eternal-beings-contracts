const fs = require("fs");
const solc = require("solc");
const { ethers } = require("ethers");

const sourcePaths = [
  "src/EternalBeings.sol",
  "src/TestExternalNFT.sol",
  "src/TestERC721Receiver.sol",
  "src/TestCryptoPunks.sol",
].filter((sourcePath) => fs.existsSync(sourcePath));

const topCollectionsRoot = process.argv[2] || "";
const royaltyReceiver = process.argv[3] || "";
const rendererAddress = process.argv[4] || "";
const outDir = process.argv[5] || "reports/verify";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/prepare-verify.js <topCollectionsRoot> <royaltyReceiver> <rendererAddress> [outDir]",
      "",
      "Example:",
      "  node scripts/prepare-verify.js 0xRoot... 0xRoyalty... 0xRenderer... reports/verify",
    ].join("\n"),
  );
}

function main() {
  if (!topCollectionsRoot || !royaltyReceiver || !rendererAddress) {
    usage();
    process.exit(1);
  }
  if (royaltyReceiver.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("royaltyReceiver must be non-zero");
  }
  if (rendererAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("rendererAddress must be non-zero");
  }

  const sources = Object.fromEntries(
    sourcePaths.map((sourcePath) => [
      sourcePath,
      {
        content: fs.readFileSync(sourcePath, "utf8"),
      },
    ]),
  );

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      evmVersion: "shanghai",
      viaIR: true,
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const encodedConstructorArgs = ethers.AbiCoder.defaultAbiCoder()
    .encode(["bytes32", "address", "address"], [topCollectionsRoot, royaltyReceiver, rendererAddress])
    .replace(/^0x/, "");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/standard-json-input.json`, `${JSON.stringify(input, null, 2)}\n`);
  fs.writeFileSync(`${outDir}/constructor-args.txt`, `${encodedConstructorArgs}\n`);

  const summary = {
    generatedAt: new Date().toISOString(),
    compilerVersion: solc.version(),
    contractPath: "src/EternalBeings.sol",
    contractName: "EternalBeings",
    fullyQualifiedName: "src/EternalBeings.sol:EternalBeings",
    optimizer: {
      enabled: true,
      runs: 1,
    },
    evmVersion: "shanghai",
    viaIR: true,
    constructorArgs: {
      topCollectionsRoot,
      royaltyReceiver,
      rendererAddress,
      abiEncodedNo0x: encodedConstructorArgs,
    },
    bytecode: {
      creationBytes: (artifact.bytecode.length - 2) / 2,
      runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
    },
    files: {
      standardJsonInput: `${outDir}/standard-json-input.json`,
      constructorArgs: `${outDir}/constructor-args.txt`,
    },
  };

  fs.writeFileSync(`${outDir}/verify-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log("prepare-verify ok");
}

main();
