# Eternal Beings Deployment Checklist

## Current Build

- Contract: `EternalBeings`
- Constructor arguments:
  - `topCollectionsRoot`: `0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f`
  - `royaltyReceiver`: must be the final royalty wallet, not the zero address
- Estimated deploy gas: about `10,574,883` on Sepolia preflight (`4,981,888` renderer + `5,592,995` game)
- EternalBeings runtime bytecode: `23474` bytes
- EternalBeings initcode: `25837` bytes
- EternalRenderer runtime bytecode: `22606` bytes
- EternalRenderer initcode: `22632` bytes
- EIP-170 runtime limit: `24576` bytes
- EIP-3860 initcode limit: `49152` bytes
- Project warning thresholds:
  - runtime: `23500` bytes
  - initcode: `48000` bytes

## Collection Root

- Curated entries: `100`
- Tier counts:
  - tier 5: `10`
  - tier 4: `20`
  - tier 3: `20`
  - tier 2: `20`
  - tier 1: `30`
- Native CryptoPunks remains in the root and uses the dedicated Punk adapter path.
- CryptoKitties, Autoglyphs, and KnownOrigin were removed.

## Required Pre-Deploy Checks

For the short testnet path, follow `TESTNET_QUICKSTART.md`.

1. Run:

```bash
npm test
```

2. Run a local deployment rehearsal:

```bash
npm run local-rehearsal
```

3. Generate the readiness report:

```bash
npm run readiness-report
```

4. Rebuild the deployment report with the real royalty wallet:

```bash
WRITE_ARTIFACTS=1 node scripts/compile.js
node scripts/deployment-report.js data/top-collections.ethereum.curated.json 0xYOUR_ROYALTY_WALLET reports/deployment-mainnet.json
```

5. Regenerate and verify the final proof file:

```bash
node scripts/generate-tier-root.js data/top-collections.ethereum.curated.json reports/top-collections.proofs.json
node scripts/verify-proof-file.js reports/top-collections.proofs.json 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
```

6. Recheck the collection list against Ethereum RPC:

```bash
node scripts/check-collections.js data/top-collections.ethereum.curated.json reports/collection-check.ethereum.json
```

7. Verify the final Merkle root in `reports/deployment-mainnet.json`.

8. Confirm the final `royaltyReceiver`. It is immutable after deployment.

9. Run a testnet rehearsal with the final root and royalty receiver.

10. Prepare block-explorer verification files:

```bash
node scripts/prepare-verify.js 0xEXPECTED_ROOT 0xROYALTY_RECEIVER 0xRENDERER reports/verify
```

11. Run a read-only deployment preflight. This does not require a private key and does not send transactions:

```bash
node scripts/validate-deployer-secret.js $RPC_URL reports/secrets/deployer.secrets.json 0xDEPLOYER 0.05
node scripts/deploy-preflight.js $RPC_URL 0xDEPLOYER 0xEXPECTED_ROOT 0xROYALTY_RECEIVER reports/deploy-preflight.json
```

For fast Sepolia rehearsal, pass the expected parameter profile as the final argument:

```bash
node scripts/deploy-preflight.js $RPC_URL 0xDEPLOYER 0xEXPECTED_ROOT 0xROYALTY_RECEIVER reports/sepolia-clean-deploy-preflight.json 0xESTIMATE_RENDERER testnet-fast
```

12. Deploy with explicit root and royalty receiver. Prefer the secret-file deployment path so the private key is not passed on the command line:

```bash
node scripts/deploy-from-secret.js $RPC_URL reports/secrets/deployer.secrets.json 0xDEPLOYER 0xEXPECTED_ROOT 0xROYALTY_RECEIVER reports/deployment-sepolia-clean.json testnet-fast
```

The secret file must be ignored by git and shaped like:

```json
{
  "wallets": [
    {
      "address": "0xDEPLOYER",
      "privateKey": "0x..."
    }
  ]
}
```

Use `config/deployer.secrets.example.json` as the public template. Put the real file under `reports/secrets/deployer.secrets.json`, which is ignored by git.

13. After testnet or mainnet deployment, run the read-only post-deploy check:

```bash
node scripts/postdeploy-check.js $RPC_URL 0xGAME 0xEXPECTED_ROOT 0xROYALTY_RECEIVER
```

14. Verify source code on the explorer using `reports/verify/standard-json-input.json` and `reports/verify/constructor-args.txt`.

15. Keep the unaudited experimental risk disclosure visible in repository docs.

16. Treat further renderer/game additions as bytecode-sensitive. Compress or remove existing code before adding large features.

## Notes

- ERC2981 royalties are marketplace metadata. They do not force private transfers or non-compliant marketplaces to pay.
- Devoured external NFTs and native CryptoPunks are intentionally not recoverable.
- The contract has no owner, pause, rescue, upgrade, or admin mint path.
- This is an unaudited small contract-only experiment; external audit is optional, not a launch blocker.
- ORE has a fixed 21,000,000 max supply, game-only minting, and a global per-block emission cap.
- Hunt rewards use NFT Power, Skill, Complexity, Mass, scene difficulty, and scene token multiplier, then pass through the emission cap.
- Fusion uses `lineageMask` inheritance and soft-capped hunt scoring, so long-running growth does not linearly explode ORE emissions.
