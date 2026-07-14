const fs = require("fs");
const solc = require("solc");

const sourcePaths = [
  "src/EternalBeings.sol",
  "src/TestExternalNFT.sol",
  "src/TestERC721Receiver.sol",
  "src/TestCryptoPunks.sol",
].filter((sourcePath) => fs.existsSync(sourcePath));

const outDir = process.argv[2] || "reports/verify-renderer";

function main() {
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

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/standard-json-input.json`, `${JSON.stringify(input, null, 2)}\n`);
  fs.writeFileSync(`${outDir}/constructor-args.txt`, "\n");

  const summary = {
    generatedAt: new Date().toISOString(),
    compilerVersion: solc.version(),
    contractPath: "src/EternalBeings.sol",
    contractName: "EternalRenderer",
    fullyQualifiedName: "src/EternalBeings.sol:EternalRenderer",
    optimizer: {
      enabled: true,
      runs: 1,
    },
    evmVersion: "shanghai",
    viaIR: true,
    constructorArgs: {},
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
  console.log("prepare-renderer-verify ok");
}

main();
