# Stock World Protocol V2 Implementation Status

Status: Autonomous v4 hook milestone, not a production deployment

Target network: Robinhood Chain

This directory tracks implementation against the architecture proposal. Code is published in narrow, tested milestones so incomplete market or reward logic is not presented as production-ready software.

## Autonomous V4 Hook Milestone

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
- `StockWorldGraduationMath`: terminal-price-preserving pool allocation and deterministic V4 sqrt-price math.
- Graduation reserve capping: the initial pool absorbs at most the virtual quote reserve, so fee churn cannot make a World permanently ungradable; excess quote remains forwardable after graduation.
- `StockWorldGraduationGuard`: exact full-range tick/liquidity preflight and signed V4 amount bounds.
- `StockWorldLiquidityLocker`: ownerless permanent custody for position NFTs and virtual-reserve token remainder.
- `StockWorldGraduationCoordinator`: one-time canonical Factory binding, immutable v4 wiring, pool creation, World registration, reserve attribution, and permanent custody finalization.
- `StockWorldGraduationExecutor`: exact per-graduation asset pulls, Permit2 action encoding, expiring approvals, explicit revocation, and residual return.
- `StockWorldHookDeployer`: ownerless CREATE2 deployment and address prediction for the permission-encoded Hook, with no withdrawal or mutation path.
- `StockWorldHook`: CREATE2 permission-bit enforcement, one-time Coordinator binding, canonical pool registration, pre-initialization protection, quote-only swap fees, pool-isolated accounting, and permissionless reward-vault sweeps.
- Permanent pools require a zero v4 core LP fee. The ownerless position cannot collect core LP fees, so the immutable 1% Hook fee is the only permanent-market fee and follows the same quote-asset reward path as the bonding curve.
- Local Ganache tests for registry permissions, configuration boundaries, fixed supply, transfers, and allowances.
- Local Ganache tests proving that pending stake and newly activated stake cannot claim historical rewards.
- Local Ganache tests for fee conservation, NFT reward checkpoints, tracked curve reserves, partial fills, slippage, and one-way graduation.
- Local Ganache tests for exact fair-mint winner counts, claim-order independence, reservation expiry, late entropy, transfer settlement, and Fusion burn invariants.
- Local Ganache tests for atomic stack deployment, exact launch-fee forwarding, canonical address records, failed-launch rollback, preflight-before-sweep, retryable graduation, and escrow conservation.
- Local Ganache tests for price-preserving graduation allocation, seed rejection boundaries, coordinator authentication, and irreversible locker custody.
- Local Ganache v4-stack tests for constructor wiring, pool initialization, action encoding, approval revocation, Hook registration, LP custody, dust attribution, full rollback, and retry.
- Local Ganache Hook tests for the `0x20cc` permission mask, callback ABI selectors, one-time wiring, initialization front-run rejection, all four exact-input/output directions, partial-fill rollback, forced-balance isolation, fee conservation, and permissionless delivery.
- Offline v4 attestation guard tests for missing code, code-size drift, bytecode-hash drift, malformed ABI responses, and invalid addresses.
- A local deployment rehearsal that mines the Hook permission address, deploys every shared production contract in dependency order, completes both one-time bindings, registers a quote asset, and launches the first complete World.

Not implemented in this milestone:

- Manipulation-resistant use of attributed post-graduation quote reserves currently conserved by the coordinator. A quote-only reserve cannot safely be swapped and added to the same pool from a caller-selected or same-block spot price.
- Robinhood Chain fork and testnet execution against the source-matched v4 candidate stack.
- An explicit production governance decision on using the source-matched third-party v4 deployment; attestation does not make it an official Uniswap deployment.
- A production platform revenue vault and any fully specified ENDSZ buyback policy.

The factory is complete enough for local lifecycle testing, but its production constructor must never receive the included mock coordinator. The missing components are required before any World can be launched on Robinhood Chain. None of the current contracts should be represented as a complete production deployment.

## Network Boundary

- Robinhood Chain mainnet chain ID: `4663`.
- Robinhood Chain testnet chain ID: `46630`.
- Native gas currency: `ETH` on both environments.
- Canonical network values are stored in `config/robinhood-chain.json`.
- Ethereum mainnet and Sepolia contract addresses must never be reused as Robinhood Chain addresses.
- External protocol addresses remain unset until their Robinhood Chain deployments are independently verified.
- On-chain candidates, bytecode hashes, and pinned Sourcify source records are stored separately in `config/robinhood-chain.v4-observed.json`; they are not production configuration.
- `stock-world:attest-v4` verifies the live code size, code hash, chain ID, PositionManager wiring, contract identity, compiler version, and Sourcify runtime match. A successful result is evidence of consistency, not official Uniswap deployment approval.

Before any future deployment, verify the connected RPC:

```bash
npm run stock-world:check-network -- testnet
npm run stock-world:attest-v4 -- mainnet
npm run stock-world:deployment-rehearsal
```

The production manifest remains intentionally blocked until the V4 dependency decision, immutable/multisig quote-asset authority, platform fee recipient, first quote assets, and deployment funding are finalized:

```bash
npm run stock-world:production-readiness
```

`config/stock-world.production.json` converts the block-based Mint schedule using a live block-cadence sample. This prevents local-test values such as `12 / 8 / 40` from reaching a fast production chain as unusably short Commit, Reveal, and Claim windows. The readiness check is read-only and never loads a private key or sends a transaction.

The deployment rehearsal also reports gas per transaction. The current measured shared deployment is `17,674,703 gas`, quote-asset registration is `50,901 gas` per asset, and the first World launch is `7,741,628 gas` paid by that World's creator. Production readiness combines the shared and registry estimates with live `maxFeePerGas` and a configurable safety multiplier instead of relying on a fixed ETH threshold.

The draft production manifest starts with ten quote assets from Robinhood's official token-contract page and `/rhj/assets` registry: USDG, SPY, QQQ, MSFT, META, AMZN, GOOGL, NVDA, AAPL, and TSLA. Readiness still checks live bytecode and ERC-20 metadata for every configured address. Inclusion means only that a World may use the token as its curve quote asset; it is not an endorsement, price guarantee, or representation of legal ownership in an underlying company.

## Local Verification

```bash
npm run test:stock-world
```

The command compiles all Solidity sources, deploys an atomic World stack to an ephemeral Ganache chain, and runs positive and negative lifecycle checks.

For browser integration work, keep the same rehearsal deployment available over a loopback-only JSON-RPC endpoint:

```bash
npm run stock-world:ui-rehearsal
```

The command binds Ganache to `127.0.0.1:8545`, deploys one complete rehearsal World, and prints the temporary Factory address, Factory deployment block, and quote asset address. It does not write an account private key or modify any website configuration. Stop it with `Ctrl+C` and never publish its temporary addresses as production values.
