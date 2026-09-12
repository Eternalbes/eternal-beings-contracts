# Stock World Protocol V2 Implementation Status

Status: Foundation milestone, not a deployable launch platform

Target network: Robinhood Chain

This directory tracks implementation against the architecture proposal. Code is published in narrow, tested milestones so incomplete market or reward logic is not presented as production-ready software.

## Foundation Milestone

Implemented:

- `StockWorldTypes`: canonical immutable launch configuration and protocol constants.
- `QuoteAssetRegistry`: authority-controlled approval for assets available to future Worlds.
- `StockWorldConfigValidator`: validation and deterministic hashing of launch configuration.
- `WorldToken`: fixed supply of 1,000,000 units with standard ERC-20 transfer and allowance behavior.
- Local Ganache tests for registry permissions, configuration boundaries, fixed supply, transfers, and allowances.

Not implemented in this milestone:

- World factory deployment.
- Bonding curve trading.
- Fair NFT minting and Fusion.
- Token and NFT reward accounting.
- Graduation and Uniswap v4 integration.
- Permanently locked liquidity.

The missing components are required before any World can be launched. None of the current foundation contracts should be represented as a complete protocol deployment.

## Network Boundary

- Robinhood Chain mainnet chain ID: `4663`.
- Robinhood Chain testnet chain ID: `46630`.
- Native gas currency: `ETH` on both environments.
- Canonical network values are stored in `config/robinhood-chain.json`.
- Ethereum mainnet and Sepolia contract addresses must never be reused as Robinhood Chain addresses.
- External protocol addresses remain unset until their Robinhood Chain deployments are independently verified.

Before any future deployment, verify the connected RPC:

```bash
npm run stock-world:check-network -- testnet
```

## Local Verification

```bash
npm run test:stock-world
```

The command compiles all Solidity sources, deploys the foundation contracts to an ephemeral Ganache chain, and runs positive and negative behavioral checks.
