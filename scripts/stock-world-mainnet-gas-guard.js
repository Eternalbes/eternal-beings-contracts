const { ethers } = require("ethers");

function installGasGuard(provider, config, report, checkpoint, limitWei, actionLabel) {
  if (limitWei <= 0n) throw new Error("deployment Gas limit must be positive");
  if (report.gasBudgetWei && report.gasBudgetWei !== limitWei.toString()) {
    throw new Error("deployment Gas budget differs from the saved approval");
  }
  report.gasBudgetWei = limitWei.toString();
  report.gasGuardTransactions ||= [];
  const broadcast = provider.broadcastTransaction.bind(provider);
  provider.broadcastTransaction = async (raw) => {
    const tx = ethers.Transaction.from(raw);
    const label = actionLabel();
    if (!/^(deploy:|create2:|bind:|register:quoteAsset:)/.test(label || "")) throw new Error("unexpected deployment action");
    if (tx.chainId !== BigInt(config.chainId) || tx.from?.toLowerCase() !== config.deployer.toLowerCase()) {
      throw new Error("deployment signer or chain mismatch");
    }
    if (tx.value !== 0n) throw new Error("deployment guard forbids sending ETH value");
    const maxFee = tx.maxFeePerGas ?? tx.gasPrice;
    if (!maxFee || tx.gasLimit <= 0n) throw new Error("deployment requires bounded gas and fee");
    if (report.gasGuardTransactions.some((item) => item.hash === tx.hash)) {
      throw new Error(`known deployment transaction must be reconciled, not re-broadcast: ${tx.hash}`);
    }
    const hashes = new Set([
      ...report.transactions.map((item) => item.hash),
      ...Object.values(report.contracts).map((item) => item.transactionHash).filter(Boolean),
      ...report.gasGuardTransactions.map((item) => item.hash),
    ]);
    let spent = 0n;
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) throw new Error(`pending or unknown deployment transaction must be reconciled first: ${hash}`);
      spent += receipt.gasUsed * receipt.gasPrice;
      const saved = report.gasGuardTransactions.find((item) => item.hash === hash);
      if (saved) Object.assign(saved, { status: receipt.status === 1 ? "mined" : "failed", gasCostWei: (receipt.gasUsed * receipt.gasPrice).toString() });
      const recorded = report.transactions.find((item) => item.hash === hash);
      if (recorded) Object.assign(recorded, { status: receipt.status === 1 ? "mined" : "failed",
        blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), gasCostWei: (receipt.gasUsed * receipt.gasPrice).toString() });
    }
    const maximum = tx.gasLimit * maxFee;
    if (spent + maximum > limitWei) throw new Error("deployment would exceed the approved total Gas budget; no transaction sent");
    report.gasSpentWei = spent.toString();
    report.gasGuardTransactions.push({ label, hash: tx.hash, nonce: tx.nonce, to: tx.to,
      predictedAddress: tx.to === null ? ethers.getCreateAddress({ from: tx.from, nonce: tx.nonce }) : null,
      dataHash: ethers.keccak256(tx.data), maximumGasCostWei: maximum.toString(), status: "prepared" });
    checkpoint();
    console.log(JSON.stringify({ signingBoundary: label, chainId: tx.chainId.toString(),
      maximumGasEth: ethers.formatEther(maximum), spentGasEth: ethers.formatEther(spent), budgetEth: ethers.formatEther(limitWei) }));
    try {
      const response = await broadcast(raw);
      report.gasGuardTransactions.at(-1).status = "pending"; checkpoint();
      return response;
    } catch (error) {
      throw new Error(`deployment broadcast outcome requires reconciliation for ${tx.hash}: ${error.code || "RPC_ERROR"}`);
    }
  };
}

module.exports = { installGasGuard };
