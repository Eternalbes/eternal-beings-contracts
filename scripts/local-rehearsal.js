const assert = require("assert");
const { execFile } = require("child_process");
const fs = require("fs");
const ganache = require("ganache");
const net = require("net");
const { buildTree } = require("./merkle");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function execNode(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }

  return objects;
}

async function main() {
  if (!fs.existsSync("artifacts/EternalBeings.json")) {
    throw new Error("Run WRITE_ARTIFACTS=1 node scripts/compile.js first");
  }

  const collections = JSON.parse(fs.readFileSync("data/top-collections.ethereum.curated.json", "utf8"));
  const root = buildTree(collections).root;
  const server = ganache.server({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
    wallet: { deterministic: true },
  });

  const port = await findFreePort();
  await server.listen(port);
  try {
    const rpcUrl = `http://127.0.0.1:${port}`;
    const accounts = server.provider.getInitialAccounts();
    const [firstAccount, secondAccount] = Object.keys(accounts);
    const privateKey = accounts[firstAccount].secretKey;
    const royaltyReceiver = secondAccount;

    const deploy = await execNode(["scripts/deploy.js", rpcUrl, privateKey, root, royaltyReceiver]);
    const deployObjects = parseJsonObjects(deploy.stdout);
    const deployment = deployObjects.find((object) => object.gameAddress);
    assert(deployment, "deploy.js output includes gameAddress");
    assert(deployment.oreAddress, "deploy.js output includes oreAddress");
    assert(deployment.rendererAddress, "deploy.js output includes rendererAddress");

    const check = await execNode(["scripts/postdeploy-check.js", rpcUrl, deployment.gameAddress, root, royaltyReceiver]);
    assert(check.stdout.includes("postdeploy-check ok"), "postdeploy-check succeeded");
    const checkObjects = parseJsonObjects(check.stdout);
    const report = checkObjects[0];
    assert.equal(report.gameAddress.toLowerCase(), deployment.gameAddress.toLowerCase(), "checked deployed game");
    assert.equal(report.topCollectionsRoot.toLowerCase(), root.toLowerCase(), "checked root");
    assert.equal(report.royaltyReceiver.toLowerCase(), royaltyReceiver.toLowerCase(), "checked royalty receiver");

    const status = await execNode(["scripts/mint-status.js", rpcUrl, deployment.gameAddress, firstAccount]);
    const statusObjects = parseJsonObjects(status.stdout);
    const mintStatus = statusObjects[0];
    assert.equal(mintStatus.phase, "commit", "fresh deployment starts in commit phase");
    assert.equal(mintStatus.user.hasMintedBeing, false, "fresh user has not minted");

    const oreStatus = await execNode(["scripts/ore-status.js", rpcUrl, deployment.gameAddress, firstAccount]);
    const oreObjects = parseJsonObjects(oreStatus.stdout);
    const ore = oreObjects[0];
    assert.equal(ore.oreAddress.toLowerCase(), deployment.oreAddress.toLowerCase(), "ore-status checks deployed ORE");
    assert.equal(ore.supplyWithinCap, true, "ORE supply remains within cap");

    console.log("local-rehearsal ok");
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  process.exit(1);
});
