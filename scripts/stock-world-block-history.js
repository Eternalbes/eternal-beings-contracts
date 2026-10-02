const fs = require("fs");
const { ethers } = require("ethers");

const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const HISTORY_WINDOW = 393168;
const MAX_CLAIM_BLOCKS = 237600;
const HISTORY_CODE_HASH = "0xceef1f6ad6c0cb7eb8fb15678abf11da3ce0d3a7c7106aa900c5930e556a43ff";
const HISTORY_CODE = "0x3373fffffffffffffffffffffffffffffffffffffffe1460605760203603605c575f3563a3b1b31d5f5260205f6004601c60645afa15605c575f51600181038211605c57816205ffd0910311605c576205ffd09006545f5260205ff35b5f5ffd5b5f356205ffd0600163a3b1b31d5f5260205f6004601c60645afa15605c575f5103065500";

async function attestBlockHistory(provider, blockNumber, probe = false) {
  const codeHash = ethers.keccak256(await provider.getCode(HISTORY, blockNumber));
  if (codeHash !== HISTORY_CODE_HASH) throw new Error("Robinhood L2 block history runtime does not match the pinned 393,168-block system contract");
  const clock = new ethers.Interface(["function arbBlockNumber() view returns (uint256)"]);
  const data = await provider.send("eth_call", [{ to: ARB_SYS, data: clock.encodeFunctionData("arbBlockNumber") }, ethers.toQuantity(blockNumber)]);
  if (clock.decodeFunctionResult("arbBlockNumber", data)[0] !== BigInt(blockNumber)) {
    throw new Error("ArbSys block clock does not match the RPC L2 block number");
  }
  const result = { address: HISTORY, codeHash, historyWindowBlocks: HISTORY_WINDOW, maximumClaimBlocks: MAX_CLAIM_BLOCKS };
  if (probe) {
    if (blockNumber <= MAX_CLAIM_BLOCKS) throw new Error("chain has insufficient history to attest the full Claim window");
    const target = blockNumber - MAX_CLAIM_BLOCKS;
    const hash = await provider.send("eth_call", [{ to: HISTORY, data: ethers.zeroPadValue(ethers.toBeHex(target), 32) }, ethers.toQuantity(blockNumber)]);
    if (hash === ethers.ZeroHash || hash !== (await provider.getBlock(target)).hash) {
      throw new Error("full-window historical entropy does not match the canonical RPC block hash");
    }
    result.probedBlock = target;
    result.probedHash = hash;
  }
  return result;
}

// Test-only Ganache setup: its EVM has no native ArbSys precompile.
async function installLocalBlockClock(chain, installHistory = true) {
  const mock = JSON.parse(fs.readFileSync("artifacts/MockArbSysNativeClock.json", "utf8"));
  await chain.request({ method: "evm_setAccountCode", params: [ARB_SYS, mock.deployedBytecode] });
  if (installHistory) await chain.request({ method: "evm_setAccountCode", params: [HISTORY, HISTORY_CODE] });
}

module.exports = { HISTORY, ARB_SYS, HISTORY_WINDOW, MAX_CLAIM_BLOCKS, HISTORY_CODE_HASH, HISTORY_CODE, attestBlockHistory, installLocalBlockClock };
