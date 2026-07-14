const fs = require("fs");
const { ethers } = require("ethers");

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/deploy.js <rpcUrl> <privateKey> <topCollectionsRoot> <royaltyReceiver>",
      "",
      "Example:",
      "  node scripts/deploy.js $RPC_URL $PRIVATE_KEY 0xRoot... 0xRoyalty...",
    ].join("\n"),
  );
}

async function main() {
  const [rpcUrl, privateKey, topCollectionsRoot, royaltyReceiver] = process.argv.slice(2);
  if (!rpcUrl || !privateKey || !topCollectionsRoot || !royaltyReceiver) {
    usage();
    process.exit(1);
  }
  if (royaltyReceiver.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new Error("royaltyReceiver must be non-zero");
  }
  if (!fs.existsSync("artifacts/EternalBeings.json") || !fs.existsSync("artifacts/EternalRenderer.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const artifact = JSON.parse(fs.readFileSync("artifacts/EternalBeings.json", "utf8"));
  const rendererArtifact = JSON.parse(fs.readFileSync("artifacts/EternalRenderer.json", "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
  const network = await provider.getNetwork();
  const rendererFactory = new ethers.ContractFactory(rendererArtifact.abi, rendererArtifact.bytecode, wallet);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log(
    JSON.stringify(
      {
        action: "deploy",
        chainId: network.chainId.toString(),
        deployer: await wallet.getAddress(),
        topCollectionsRoot,
        royaltyReceiver,
      },
      null,
      2,
    ),
  );

  const renderer = await rendererFactory.deploy();
  const rendererReceipt = await renderer.deploymentTransaction().wait();
  const rendererAddress = await renderer.getAddress();
  const contract = await factory.deploy(topCollectionsRoot, royaltyReceiver, rendererAddress);
  const receipt = await contract.deploymentTransaction().wait();
  const gameAddress = await contract.getAddress();
  const oreAddress = await contract.ore();

  console.log(
    JSON.stringify(
      {
        gameAddress,
        oreAddress,
        rendererAddress,
        rendererDeploymentTransaction: rendererReceipt.hash,
        rendererGasUsed: rendererReceipt.gasUsed.toString(),
        deploymentTransaction: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        postDeployCheck: `node scripts/postdeploy-check.js <rpcUrl> ${gameAddress} ${topCollectionsRoot} ${royaltyReceiver}`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
