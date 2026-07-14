const fs = require("fs");
const solc = require("solc");
const { ethers } = require("ethers");

const sourcePaths = [
  "src/EternalBeings.sol",
  "src/TestExternalNFT.sol",
  "src/TestERC721Receiver.sol",
  "src/TestCryptoPunks.sol",
].filter((sourcePath) => fs.existsSync(sourcePath));

const minterAddress = process.argv[2] || "";
const outDir = process.argv[3] || "reports/verify-ore";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/prepare-ore-verify.js <minterAddress> [outDir]",
      "",
      "Example:",
      "  node scripts/prepare-ore-verify.js 0xGame... reports/verify-ore",
    ].join("\n"),
  );
}

function main() {
  if (!minterAddress) {
    usage();
    process.exit(1);
  }
  if (minterAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("minterAddress must be non-zero");
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

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalOre.json", "utf8"));
  const encodedConstructorArgs = ethers.AbiCoder.defaultAbiCoder()
    .encode(["address"], [minterAddress])
    .replace(/^0x/, "");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/standard-json-input.json`, `${JSON.stringify(input, null, 2)}\n`);
  fs.writeFileSync(`${outDir}/constructor-args.txt`, `${encodedConstructorArgs}\n`);

  const summary = {
    generatedAt: new Date().toISOString(),
    compilerVersion: solc.version(),
    contractPath: "src/EternalBeings.sol",
    contractName: "EternalOre",
    fullyQualifiedName: "src/EternalBeings.sol:EternalOre",
    optimizer: {
      enabled: true,
      runs: 1,
    },
    evmVersion: "shanghai",
    viaIR: true,
    constructorArgs: {
      minterAddress,
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
  console.log("prepare-ore-verify ok");
}

main();
