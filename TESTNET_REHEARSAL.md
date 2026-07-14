# Eternal Beings Testnet Rehearsal

Run this before any mainnet deployment if the project remains unaudited.

## Deploy

1. Run the local deploy/check rehearsal first:

```bash
npm run local-rehearsal
```

2. Apply the fast testnet parameter profile so public-testnet testing does not require waiting a full production epoch:

```bash
npm run params:testnet-fast
```

This profile uses a 12-block epoch, 4-block commit phase, immediate external NFT devour after observation, and 1-block hunt cooldown.

Before any mainnet build or deployment, restore production parameters:

```bash
npm run params:mainnet
```

3. Build artifacts:

```bash
WRITE_ARTIFACTS=1 node scripts/compile.js
```

4. Generate or confirm the final top-collection Merkle root:

```bash
node scripts/generate-tier-root.js data/top-collections.ethereum.curated.json reports/top-collections.proofs.json
node scripts/verify-proof-file.js reports/top-collections.proofs.json 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
```

5. Deploy `EternalBeings` with:

```text
topCollectionsRoot = final root
royaltyReceiver = final non-zero wallet
```

```bash
node scripts/prepare-verify.js 0xEXPECTED_ROOT 0xROYALTY_RECEIVER 0xRENDERER reports/verify
node scripts/validate-deployer-secret.js $RPC_URL reports/secrets/deployer.secrets.json 0xDEPLOYER 0.05
node scripts/deploy-preflight.js $RPC_URL 0xDEPLOYER 0xEXPECTED_ROOT 0xROYALTY_RECEIVER reports/sepolia-clean-deploy-preflight.json 0xESTIMATE_RENDERER testnet-fast
node scripts/deploy-from-secret.js $RPC_URL reports/secrets/deployer.secrets.json 0xDEPLOYER 0xEXPECTED_ROOT 0xROYALTY_RECEIVER reports/deployment-sepolia-clean.json testnet-fast
```

Prefer `deploy-from-secret.js` over `deploy.js` so the private key is not passed through the shell command line. `reports/secrets/` is ignored by git.
Use `config/deployer.secrets.example.json` as the shape for `reports/secrets/deployer.secrets.json`; do not put a real key in `config/`.

6. Verify source code on the explorer with the exact constructor arguments.

Use:

```text
reports/verify/standard-json-input.json
reports/verify/constructor-args.txt
```

7. Run the read-only post-deploy check:

```bash
node scripts/postdeploy-check.js $RPC_URL 0xGAME 0xEXPECTED_ROOT 0xROYALTY_RECEIVER
```

Or run the clean deployment rehearsal bundle after `deploy-from-secret.js` writes the deployment report:

```bash
node scripts/sepolia-clean-rehearsal.js $RPC_URL reports/deployment-sepolia-clean.json reports/secrets/deployer.secrets.json reports/sepolia-clean
```

This runs post-deploy checks, prepares explorer verification files, mints two fast-testnet Beings, checks token metadata, and checks marketplace compatibility.

## Smoke Test

Use explorer contract-write calls, wallet calls, or scripts. Do not rely on an official UI.

1. Call `currentEpoch()` and `releasedMintCap(currentEpoch)`.
2. Commit with `commitMint(commitment)`.
3. Reveal with `revealMint(epoch, secret)`.
4. Claim with `claimMint(epoch)`.
5. Confirm:

```text
ownerOf(tokenId)
getBeing(tokenId)
tokenURI(tokenId)
```

6. Call `enterHunt(tokenId)`.
7. Confirm `ownerOf(tokenId)` is the game contract.
8. Wait or mine enough blocks, then call `resolveHunt(tokenId)`.
9. Confirm the NFT returned to the hunter and ORE balance increased only within `emittedCap()`.
10. Transfer a test external ERC721 into the devour flow:

```text
observeExternal(nft, externalTokenId)
devourExternal(beingId, nft, externalTokenId)
```

11. Confirm the devoured NFT is owned by the game contract and cannot be rescued.
12. Fuse two test Beings with `fuseBeing(parentId, sacrificeId)`.
13. Confirm the sacrifice `ownerOf()` and `tokenURI()` revert.
14. Check `royaltyInfo(tokenId, salePrice)` returns the intended receiver and 3%.
15. Check ORE transfer and approval.

## Must Match Mainnet Plan

- Same collection root.
- Same royalty receiver class of wallet, ideally the exact final wallet if safe.
- Same compiler settings.
- Same deployment script.
- Same post-deploy report command.

## Stop Conditions

Do not deploy mainnet if any of these happen on testnet:

- `tokenURI()` fails or returns malformed metadata.
- A hunting NFT can be transferred, approved, fused, or devoured outside the expected flow.
- ORE supply exceeds `emittedCap()` or `TOKEN_MAX_SUPPLY()`.
- A devoured external NFT or native Punk can be removed from the game contract.
- The final Merkle root or royalty receiver is uncertain.
