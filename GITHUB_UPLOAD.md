# GitHub Upload Notes

This directory is the clean public contract-source package for Eternal Beings.

Before pushing:

1. Do not add real deployer private keys, test wallet private keys, mnemonic files, keystores, API keys, or `.env` files.
2. Keep real secrets only in the local project under `reports/secrets/`, which is intentionally ignored.
3. Run `npm install` after cloning; `node_modules/` is not included.
4. Run `npm test` before release.
5. Mainnet deployment should use:

```bash
npm run deploy:mainnet:one-click -- --confirm-mainnet-deploy
```

The one-click deployment script prints and writes the deployed Game, Renderer, and ORE contract addresses after deployment.

Website source is intentionally not included in this GitHub package.
