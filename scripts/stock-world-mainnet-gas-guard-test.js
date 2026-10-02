const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { installGasGuard } = require("./stock-world-mainnet-gas-guard");

async function main() {
  const wallet = ethers.Wallet.createRandom(), receipts = new Map();
  let forwards = 0, label = "deploy:test", checkpoints = 0;
  const provider = {
    getTransactionReceipt: async (hash) => receipts.get(hash),
    broadcastTransaction: async (raw) => {
      forwards++; const tx = ethers.Transaction.from(raw);
      receipts.set(tx.hash, { gasUsed: 4n, gasPrice: 1n, status: 1 });
      return { hash: tx.hash };
    },
  };
  const config = { chainId: 4663, deployer: wallet.address };
  const report = { contracts: {}, transactions: [] };
  installGasGuard(provider, config, report, () => checkpoints++, 20n, () => label);
  const signed = (nonce, overrides = {}) => wallet.signTransaction({ chainId: 4663, nonce, type: 2,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 10n, data: "0x6000", ...overrides });
  const first = await signed(0);
  await provider.broadcastTransaction(first); assert.equal(forwards, 1); assert(checkpoints >= 2);
  await assert.rejects(provider.broadcastTransaction(first), /reconciled/);
  await assert.rejects(provider.broadcastTransaction(await signed(1, { gasLimit: 17n })), /budget/);
  await assert.rejects(provider.broadcastTransaction(await signed(1, { chainId: 46630 })), /chain mismatch/);
  await assert.rejects(provider.broadcastTransaction(await signed(1, { value: 1n })), /forbids/);
  label = "buy"; await assert.rejects(provider.broadcastTransaction(await signed(1)), /unexpected/);
  label = "bind:test"; await provider.broadcastTransaction(await signed(1)); assert.equal(forwards, 2);
  assert.equal(report.gasSpentWei, "4");
  assert.throws(() => installGasGuard(provider, config, report, () => {}, 21n, () => label), /differs/);
  console.log("PASS: bounded fees, actual receipt accounting, duplicate/chain/value/action rejection, checkpoint and budget immutability");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
