# Eternal Beings Sepolia Deployment

Network:

```text
Ethereum Sepolia
chainId: 11155111
RPC used: https://ethereum-sepolia-rpc.publicnode.com
```

Deployment:

```text
gameAddress: 0x94064aECf9767756A2161b9C0F2a70597AfF77ee
oreAddress: 0x190554072611b7aa1af8f4f06226Bc3Fa4e5c38C
rendererAddress: 0xdEe7fc603e94E4B80B0f5651e225d7763cF47Ed6
deploymentTransaction: 0x7f69b8a3c96c74c8c2e174c0647b2e46089ff861faafa89f729d364524da2387
deployedAtBlock: 11180695
gasUsed: 9950170
```

Immutable deployment parameters:

```text
topCollectionsRoot: 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
royaltyReceiver: 0x7Eb7C0d2Fe5B3C35b34cD4c512b119C2167BB749
```

Explorer:

```text
https://sepolia.etherscan.io/address/0x94064aECf9767756A2161b9C0F2a70597AfF77ee
https://sepolia.etherscan.io/address/0x190554072611b7aa1af8f4f06226Bc3Fa4e5c38C
https://sepolia.etherscan.io/address/0xdEe7fc603e94E4B80B0f5651e225d7763cF47Ed6
https://sepolia.etherscan.io/tx/0x7f69b8a3c96c74c8c2e174c0647b2e46089ff861faafa89f729d364524da2387
```

Post-deploy check:

```bash
node scripts/postdeploy-check.js \
  https://ethereum-sepolia-rpc.publicnode.com \
  0x94064aECf9767756A2161b9C0F2a70597AfF77ee \
  0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f \
  0x7eb7c0d2fe5b3c35b34cd4c512b119c2167bb749
```

Etherscan verification:

```text
game: Pass - Verified
ore: Pass - Verified
renderer: Pass - Verified
```

```bash
node scripts/prepare-verify.js \
  0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f \
  0x7eb7c0d2fe5b3c35b34cd4c512b119c2167bb749 \
  reports/verify-sepolia

ETHERSCAN_API_KEY=... node scripts/etherscan-verify.js \
  11155111 \
  0x94064aECf9767756A2161b9C0F2a70597AfF77ee \
  reports/verify-sepolia
```

Mint smoke test:

```text
epoch: 0
commitTx: 0x53509f7986336349e5ff929ce24e5b3eee031c774af08cc64988ecd597ffbeee
commitBlockNumber: 11180720
commitment: 0xfeacc45dd362d019e5122d866962fa45c2c10ae102c84d4329c39d58324a605d
secretHash: stored locally in reports/secrets/sepolia-mint-smoke.secrets.json
revealStartsAtBlock: 11185495
claimStartsAtBlock: 11187895
```

Continued test status on 2026-07-02:

```text
checkedBlock: 11180925
currentPhase: commit
blocksUntilReveal: 4576
postDeployCheck: ok
oreStatus: ok
duplicateCommitProtection: execution reverted: "already committed"
earlyRevealProtection: execution reverted: "not reveal phase"
earlyClaimProtection: execution reverted: "claim not started"
```

Bulk commit stress test on 2026-07-02:

```text
generatedWallets: 400
fundedWallets: 400
committedWallets: 400
epoch: 0
firstCommitTx: 0x4f4b20a0ec8372ccbed6ff27e8ce8d7da4b26b38327140b7bdd1c57cf04a2610
lastCommitTx: 0x68d335eef2e64f962626e8576114c67b70d89878220fc08cb18c64e95fd21e31
checkedBlockAfterBulkCommit: 11181063
remainingFunderBalanceEth: 0.068229965665531575
report: reports/sepolia-bulk-commit-400.json
```

The wallet has committed for epoch 0. Wait until block `11185495` or later, then reveal with the local
secret in `reports/secrets/sepolia-mint-smoke.secrets.json`.

After block `11187895`, call `claimMint(0)` if the reveal did not mint immediately.
The full smoke-test record is stored in `reports/sepolia-mint-smoke.json`.

The deployment wallet/private key used for this testnet deployment was shared in chat. Treat it as testnet-only and do not reuse it for mainnet.
