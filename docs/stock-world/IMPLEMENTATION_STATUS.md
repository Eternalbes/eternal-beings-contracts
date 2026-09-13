# Stock World Protocol V2 Implementation Status

Status: Atomic launch milestone, not a production deployment

Target network: Robinhood Chain

This directory tracks implementation against the architecture proposal. Code is published in narrow, tested milestones so incomplete market or reward logic is not presented as production-ready software.

## Atomic Launch Milestone

Implemented:

- `StockWorldTypes`: canonical immutable launch configuration and protocol constants.
- `QuoteAssetRegistry`: authority-controlled approval for assets available to future Worlds.
- `StockWorldConfigValidator`: validation and deterministic hashing of launch configuration.
- `WorldToken`: fixed supply of 1,000,000 units with standard ERC-20 transfer and allowance behavior.
- `TokenRewardVault`: next-block stake activation and cumulative quote-asset reward accounting.
- `WorldRewardVault`: immutable Token/NFT/Creator fee splitting, NFT weight accounting, and zero-weight reserves.
- `StockWorldBondingCurve`: tracked-reserve constant-product trading, quote-leg fees, partial final fills, and one-way graduation sweep.
- `WorldNFT`: fixed historical supply, reward-aware transfers, on-chain metadata, and single-pair Fusion with permanent sacrifice burn.
- `FairMintController`: repeating gas-only commit/reveal epochs, exact winner intervals, wallet limits, and expiring reservations.
- `StockWorldCoreDeployer` and `StockWorldNftDeployer`: stateless bytecode shards that keep deployer runtimes below EIP-170 limits.
- `StockWorldLaunchDeployer`: creates every per-World module as one atomic launch operation.
- `StockWorldFactory`: exact-fee launch, canonical World records, deterministic curve and mint parameters, module binding, and permissionless graduation coordination.
- `StockWorldGraduationEscrow`: per-World reserve custody with no owner withdrawal, atomic coordinator release, and post-graduation reserve forwarding.
- `IStockWorldGraduationCoordinator`: fixed integration boundary for preflight and permanent-market creation.
- Local Ganache tests for registry permissions, configuration boundaries, fixed supply, transfers, and allowances.
- Local Ganache tests proving that pending stake and newly activated stake cannot claim historical rewards.
- Local Ganache tests for fee conservation, NFT reward checkpoints, tracked curve reserves, partial fills, slippage, and one-way graduation.
- Local Ganache tests for exact fair-mint winner counts, claim-order independence, reservation expiry, late entropy, transfer settlement, and Fusion burn invariants.
- Local Ganache tests for atomic stack deployment, exact launch-fee forwarding, canonical address records, failed-launch rollback, preflight-before-sweep, retryable graduation, and escrow conservation.

Not implemented in this milestone:

- A production `StockWorldGraduationCoordinator` for Robinhood Chain's verified Uniswap v4 deployment.
- The Uniswap v4 fee hook and World Token-to-quote conversion path.
- Permanent liquidity position creation and a no-withdrawal liquidity locker.
- A production platform revenue vault and any fully specified ENDSZ buyback policy.

The factory is complete enough for local lifecycle testing, but its production constructor must never receive the included mock coordinator. The missing components are required before any World can be launched on Robinhood Chain. None of the current contracts should be represented as a complete production deployment.

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

The command compiles all Solidity sources, deploys an atomic World stack to an ephemeral Ganache chain, and runs positive and negative lifecycle checks.
