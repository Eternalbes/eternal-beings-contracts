# Eternal Beings Testnet Quickstart

This is the shortest path to a testnet rehearsal. It assumes no official UI.

## 0. Required Inputs

Prepare:

```text
TESTNET_RPC_URL
PRIVATE_KEY
ROYALTY_RECEIVER
```

You can start with a public Sepolia RPC:

```bash
export TESTNET_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

If it is slow or rate-limited, replace it with another Sepolia RPC or a private RPC provider.

`ROYALTY_RECEIVER` must be non-zero and should be the same type of wallet you plan to use on mainnet.

## 1. Local Checks

```bash
npm test
npm run local-rehearsal
npm run readiness-report
```

Expected readiness status:

```text
ready-for-testnet-rehearsal
```

## 2. Final Root And Proofs

```bash
node scripts/generate-tier-root.js data/top-collections.ethereum.curated.json reports/top-collections.proofs.json
node scripts/verify-proof-file.js reports/top-collections.proofs.json 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
```

Expected root:

```text
0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
```

## 3. Prepare Verify Files

```bash
node scripts/prepare-verify.js 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f $ROYALTY_RECEIVER 0xRENDERER reports/verify
```

Keep:

```text
reports/verify/standard-json-input.json
reports/verify/constructor-args.txt
```

## 4. Deploy Testnet

```bash
node scripts/deploy.js $TESTNET_RPC_URL $PRIVATE_KEY 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f $ROYALTY_RECEIVER
```

Save the printed:

```text
gameAddress
oreAddress
rendererAddress
deploymentTransaction
gasUsed
```

## 5. Post-Deploy Check

```bash
node scripts/postdeploy-check.js $TESTNET_RPC_URL 0xGAME 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f $ROYALTY_RECEIVER
```

Expected:

```text
postdeploy-check ok
```

## 6. Manual Smoke Test

Use explorer write calls or scripts:

```bash
node scripts/mint-status.js $TESTNET_RPC_URL 0xGAME 0xYOUR_ADDRESS
node scripts/mint-commitment.js 0xYOUR_ADDRESS EPOCH "your private secret"
```

Then call:

```text
commitMint(commitment)
revealMint(epoch, secretHash)
claimMint(epoch)
```

After mint:

```bash
node scripts/being-status.js $TESTNET_RPC_URL 0xGAME TOKEN_ID
node scripts/token-metadata.js $TESTNET_RPC_URL 0xGAME TOKEN_ID reports/testnet-token-TOKEN_ID.svg
node scripts/ore-status.js $TESTNET_RPC_URL 0xGAME 0xYOUR_ADDRESS
```

Then test:

```text
enterHunt(tokenId)
resolveHunt(tokenId)
fuseBeing(parentId, sacrificeId)
observeExternal(nft, tokenId)
devourExternal(beingId, nft, tokenId)
```

## Stop Conditions

Do not proceed to mainnet if:

- `postdeploy-check` fails.
- `tokenURI` cannot be decoded.
- Hunt does not lock and return the NFT.
- ORE exceeds `emittedCap`.
- Devoured external NFTs are not locked in the game contract.
- The deployed root or royalty receiver is wrong.
