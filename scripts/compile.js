const fs = require("fs");
const solc = require("solc");

const sourcePaths = [
  "src/EternalBeings.sol",
  "src/TestExternalNFT.sol",
  "src/TestReentrantExternalNFT.sol",
  "src/TestERC721Receiver.sol",
  "src/TestCryptoPunks.sol",
  "src/TestBatchFusion.sol",
].filter((sourcePath) => fs.existsSync(sourcePath));
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
  sources: {
    ...sources,
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 1,
    },
    evmVersion: "shanghai",
    viaIR: true,
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors || [];

for (const error of errors) {
  console.log(error.formattedMessage);
}

if (errors.some((error) => error.severity === "error")) {
  process.exit(1);
}

for (const [file, contracts] of Object.entries(output.contracts || {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    const creationBytes = artifact.evm.bytecode.object.length / 2;
    const runtimeBytes = artifact.evm.deployedBytecode.object.length / 2;
    console.log(`${file}:${name} creation ${creationBytes} bytes, runtime ${runtimeBytes} bytes`);
  }
}

if (process.env.WRITE_ARTIFACTS === "1") {
  fs.mkdirSync("artifacts", { recursive: true });
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, artifact] of Object.entries(contracts)) {
      fs.writeFileSync(
        `artifacts/${name}.json`,
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            abi: artifact.abi,
            bytecode: `0x${artifact.evm.bytecode.object}`,
            deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
          },
          null,
          2,
        ),
      );
    }
  }
}
