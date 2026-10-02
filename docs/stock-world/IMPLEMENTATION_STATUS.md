# Stock World Protocol V2 Implementation Status

Status: Security fixes lifecycle-tested on Robinhood testnet; the V8 shared stack is deployed on Robinhood mainnet (4663) and the V2 website is switched to its new Factory. Existing immutable deployments are not updated by source changes. See `MAINNET_DEPLOYMENT_V8.md` for addresses, checks, and limitations.

Target network: Robinhood Chain

This directory tracks implementation against the architecture proposal. Code is published in narrow, tested milestones so incomplete market or reward logic is not presented as production-ready software.

## Autonomous V4 Hook Milestone

Implemented:

- `StockWorldTypes`: canonical immutable launch configuration and protocol constants.
- `QuoteAssetRegistry`: authority-controlled approval for assets available to future Worlds.
- `StockWorldConfigValidator`: validation and deterministic hashing of launch configuration.
- `WorldToken`: PONS-compatible fixed supply of 1,000,000,000 units with standard ERC-20 transfer and allowance behavior.
- `TokenRewardVault`: next-L2-block stake activation through ArbSys with a standard-EVM fallback, plus index-delta reward accounting and beneficiary-owned fractional remainders.
- `WorldRewardVault`: immutable Token/NFT/Creator fee splitting, NFT weight accounting, and zero-weight reserves.
- `StockWorldBondingCurve`: tracked-reserve constant-product trading, quote-leg fees, partial final fills, and one-way graduation sweep.
- Native ETH as the default quote asset (`address(0)`), with registry-approved ERC-20 Stock Tokens and other assets remaining selectable alternatives.
- An immutable graduation-target ceiling that guarantees the curve target plus its maximum reward-liquidity contribution remains representable by the permanent v4 seed path.
- `WorldNFT`: fixed historical supply, reward-aware transfers, on-chain metadata, and single-pair Fusion with permanent sacrifice burn.
- `FairMintController`: repeating gas-only commit/reveal epochs, exact winner intervals, wallet limits, epoch-anchored claim deadlines, and expiring reservations. The pinned ArbOS history system covers the entire 237,600-block maximum Claim window, including a first-ever delayed Claim in an oversubscribed epoch. All presets use that Claim window; Custom Claim is bounded to 1,200-237,600 blocks. No 256-block keeper deadline is required. Delayed settlement cannot reopen a stale epoch or reserve future supply. An unavailable entropy hash still expires any epoch requiring winner selection; predictable late seeds are restricted to all-revealer allocations.
- Immutable V1-compatible Mint difficulty selection: Easy (`999` per 475,200-block epoch), Hard (`666` per 712,800-block epoch), Hell (`333` per 1,188,000-block epoch), and contract-bounded Custom schedules. These full epochs include Commit, Reveal, and the common 237,600-block Claim window. Stock World does not include Hunt settings; displayed wall-clock estimates are derived from live chain cadence.
- `StockWorldCoreDeployer` and `StockWorldNftDeployer`: bytecode shards that keep deployer runtimes below EIP-170 limits. The NFT deployer is permanently bound to the shared `StockWorldRenderer`.
- `StockWorldRenderer`: combines each World's immutable image/vector/palette/style seed with each NFT genome and Fusion state into fully on-chain SVG metadata.
- `StockWorldLaunchDeployer`: creates every per-World module as one atomic launch operation.
- `StockWorldFactory`: exact-fee launch, canonical World records, deterministic curve and mint parameters, module binding, and permissionless graduation coordination.
- `StockWorldGraduationEscrow`: per-World reserve custody with no owner withdrawal, atomic coordinator release, and post-graduation quote-reserve forwarding into the permanent sink.
- `IStockWorldGraduationCoordinator`: fixed integration boundary for preflight and permanent-market creation.
- `StockWorldGraduationMath`: terminal-price-preserving pool allocation and deterministic V4 sqrt-price math.
- Graduation reserve capping: the initial pool absorbs at most the virtual quote reserve, so fee churn cannot make a World permanently ungradable; excess quote remains forwardable after graduation.
- `StockWorldGraduationGuard`: exact full-range tick/liquidity preflight and signed V4 amount bounds.
- `StockWorldLiquidityLocker`: ownerless permanent custody for position NFTs and virtual-reserve token remainder.
- `StockWorldGraduationCoordinator`: one-time canonical Factory binding, immutable v4 wiring, pool creation, World registration, permanent quote-reserve attribution, and permanent custody finalization. The public lock-policy constant and absence of withdrawal, swap, claim, rescue, or upgrade entry points make the terminal reserve state explicit.
- `StockWorldGraduationExecutor`: exact per-graduation asset pulls, Permit2 action encoding, expiring approvals, explicit revocation, and residual return.
- `StockWorldHookDeployer`: ownerless CREATE2 deployment and address prediction for the permission-encoded Hook, with no withdrawal or mutation path.
- `StockWorldHook`: CREATE2 permission-bit enforcement, one-time Coordinator binding, canonical pool registration, pre-initialization protection, quote-only swap fees, pool-isolated accounting, and permissionless reward-vault sweeps.
- Permanent pools require a zero v4 core LP fee. The ownerless position cannot collect core LP fees, so the immutable 1% Hook fee is the only permanent-market fee and follows the same quote-asset reward path as the bonding curve.
- Local Ganache tests for registry permissions, configuration boundaries, fixed supply, transfers, and allowances.
- Local Ganache tests proving that pending stake and newly activated stake cannot claim historical rewards.
- Local Ganache tests for fee conservation, NFT reward checkpoints, tracked curve reserves, partial fills, slippage, and one-way graduation.
- Local Ganache tests for exact fair-mint winner counts, claim-order independence, delayed-finalization expiry, reservation release, late all-revealer allocation, transfer settlement, and Fusion burn invariants. The canonical ArbOS history runtime is also exercised with a first Claim at the final permitted block, oversubscription, history-window boundaries, forged-runtime rejection, and no reopening of an expired deadline.
- Local Ganache tests for atomic stack deployment, exact launch-fee forwarding, canonical address records, failed-launch rollback, preflight-before-sweep, retryable graduation, and escrow conservation.
- Local Ganache tests for price-preserving graduation allocation, seed rejection boundaries, coordinator authentication, and irreversible locker custody.
- Local Ganache v4-stack tests for constructor wiring, pool initialization, action encoding, approval revocation, Hook registration, LP custody, dust attribution, full rollback, and retry.
- Local Ganache Hook tests for the `0x20cc` permission mask, callback ABI selectors, one-time wiring, initialization front-run rejection, all four exact-input/output directions, partial-fill rollback, forced-balance isolation, fee conservation, and permissionless delivery.
- Offline v4 attestation guard tests for missing code, code-size drift, bytecode-hash drift, malformed ABI responses, and invalid addresses.
- A local deployment rehearsal that mines the Hook permission address, deploys every shared production contract in dependency order, completes both one-time bindings, registers a quote asset, and launches the first complete World.
- A Robinhood mainnet-fork production-deployer test that uses live V4 and quote-asset code, completes the checkpointed deployment, verifies every immutable dependency, and reruns from the same report without duplicate deployment.
- Security regressions for selective-reveal late-seed grinding, reward rounding insolvency, and beneficiary fractions across stake changes and NFT transfers.
- Build-bound production and testnet deployment reports, including constructor/creation-transaction checks, runtime hashes, and recovery of mined transactions that were still checkpointed as pending.

Not implemented in this milestone:

- Robinhood Chain testnet execution against a source-matched V4 stack. The observed mainnet candidates are not available at the same addresses on testnet.
- A production platform revenue vault and any fully specified ENDSZ buyback policy.

The approved production manifest uses the source-matched third-party v4 deployment recorded in `config/robinhood-chain.v4-observed.json`; attestation does not make it an official Uniswap deployment. The factory and production coordinator pass local lifecycle, deployment-rehearsal, live dependency-attestation, quote-asset, balance, and dynamic gas-budget checks. Testnet Worlds use an explicitly mocked v4 stack and must not be represented as production markets. The V8 mainnet deployment was separately approved and completed on 2026-09-30 with a 0.002 ETH Gas hard limit. Live DEX full graduation remains untested. Future mainnet transactions require their own authorization.

## Network Boundary

- Robinhood Chain mainnet chain ID: `4663`.
- Robinhood Chain testnet chain ID: `46630`.
- Native gas currency: `ETH` on both environments.
- Canonical network values are stored in `config/robinhood-chain.json`.
- Ethereum mainnet and Sepolia contract addresses must never be reused as Robinhood Chain addresses.
- Generic network configuration leaves external protocol addresses unset. The approved production manifest pins independently verified addresses and must pass live attestation immediately before deployment.
- On-chain candidates, bytecode hashes, and pinned Sourcify source records are stored separately in `config/robinhood-chain.v4-observed.json`; they are not production configuration.
- `stock-world:attest-v4` verifies the live code size, code hash, chain ID, PositionManager wiring, contract identity, compiler version, and Sourcify runtime match. A successful result is evidence of consistency, not official Uniswap deployment approval.

Before any future deployment, verify the connected RPC:

```bash
npm run stock-world:check-network -- testnet
npm run stock-world:attest-v4 -- mainnet
npm run stock-world:deployment-rehearsal
npm run stock-world:production-deploy-test
```

The production manifest contains the approved V4 dependency decision, authority, platform recipient, initial quote assets, and gas budget. Re-run the read-only live check immediately before any explicit deployment approval:

```bash
npm run stock-world:production-readiness
```

Mint presets are protocol constants rather than deployment-manifest values, preventing a deployment operator from silently changing a named difficulty. Production readiness converts all three block-based presets using a live block-cadence sample and reports their observed durations. The readiness check is read-only and never loads a private key or sends a transaction.

The deployment rehearsal also reports gas per transaction. The current measured shared deployment is `20,554,718 gas`, quote-asset registration is `96,639 gas` per asset, and the first World launch is approximately `8,255,932 gas` paid by that World's creator. Production readiness uses a rounded `21,000,000 gas` shared budget, a `110,000 gas` per-asset budget, live `maxFeePerGas`, and a 1.5x safety multiplier instead of relying on a fixed ETH threshold.

The draft production manifest starts with ten quote assets from Robinhood's official token-contract page and `/rhj/assets` registry: USDG, SPY, QQQ, MSFT, META, AMZN, GOOGL, NVDA, AAPL, and TSLA. Readiness still checks live bytecode and ERC-20 metadata for every configured address. Inclusion means only that a World may use the token as its curve quote asset; it is not an endorsement, price guarantee, or representation of legal ownership in an underlying company.

The production deployer is checkpointed and resumable. Its default mode only runs the read-only readiness gate. Broadcasting requires the ignored deployer secret, `--broadcast`, and the exact chain-specific confirmation phrase; every mined address and transaction hash is written to an ignored deployment report before the next step begins:

Both deployment scripts reject stale artifacts and reports from a different build. Compile first with `WRITE_ARTIFACTS=1 npm run compile`. Older reports without build binding cannot be reused for this release: retain the historical report and choose a new `--output` path for an explicitly approved new deployment. Do not manually edit an old report to bypass this check. New code does not patch immutable contracts already on-chain.

```bash
npm run stock-world:production-deploy
npm run stock-world:production-deploy -- --broadcast --confirm DEPLOY-STOCK-WORLD-4663 --max-total-gas-eth 0.002 --output reports/deployment-stock-world-mainnet-v8.json
```

The Gas budget is an explicit approval limit, not a recommended constant. Choose it after the live estimate. The signer checks actual prior receipt costs plus the next transaction's maximum fee before broadcasting; it rejects transfers of ETH value and checkpoints the signed transaction hash before sending. Run `node scripts/stock-world-mainnet-gas-guard-test.js` to exercise these limits without contacting a network.

Pass `--site-config ../eternalbes-site/stock-world/config.json` only when its chain already matches the deployment. It writes the deployed Factory address, Factory deployment block, network endpoints, and configured quote assets after all on-chain checks pass. Switching from testnet to mainnet requires a separate explicit website configuration update, including the environment and chain label. The deployer never publishes the website itself.

The deployer will not bypass a blocked manifest. Set `status` to `approved-for-deployment` only after every immutable address and external V4 dependency has been reviewed. If the immutable quote-asset authority is not the deployer, the report ends in `awaiting-quote-asset-authority` and lists the assets that authority must register.

## Local Verification

```bash
npm run test:stock-world
```

The command compiles all Solidity sources, deploys an atomic World stack to an ephemeral Ganache chain, and runs positive and negative lifecycle checks.

After compilation, `npm run stock-world:testnet-deploy-test` exercises the testnet deployment script on localhost only. It verifies build-mismatch rejection, recovery of an already-mined Factory, and unchanged transaction count on resume. It uses an ephemeral random key and removes temporary files; it does not deploy to the public testnet. `npm run stock-world:production-deploy-test` runs equivalent recovery checks on a local mainnet fork.

`npm run stock-world:testnet-security-smoke-test` additionally runs the public-testnet lifecycle runner against an ephemeral localhost chain with timed blocks. It covers three-step Mint, invalid/repeated actions, on-chain metadata decoding, a small buy/sell, exact-amount approvals, activation of stake, rewards for Token/NFT/Creator beneficiaries, and full withdrawal of the test stake.

`npm run stock-world:testnet-security-smoke` is plan-only by default. Broadcasting requires `--broadcast --confirm TEST-STOCK-WORLD-SECURITY-46630` and prior authorization for the listed actions. It accepts an explicit build-bound `--deployment` report, restricts the network to `46630`, caps transaction spend (default `0.001` test ETH), and stores Mint secrets separately from transaction reports under ignored paths. It does not burn NFTs, grant unlimited approvals, or publish website configuration. If interrupted, inspect the saved report and Mint secret before attempting any recovery; the runner rejects existing output paths rather than blindly repeating trades.

### Historical Entropy Testnet Recheck

On September 30, 2026, the historical-block-hash release was deployed to Robinhood Chain testnet (`46630`): Factory `0x7532370cBb47b183CF7DbAa0daC59aDD74DeCa2F`, deployment block `126468589`. No mainnet transactions or old NFT burns were performed.

- World `0`: the public-chain lifecycle runner passed 14 checks with 14 transactions, including Commit / Reveal / Claim, on-chain JSON and SVG decoding, buy / sell, exact approvals, stake activation and principal withdrawal, and Token / NFT / Creator reward claims. Repeated claims and unauthorized Mint/reward updates were rejected.
- World `1`: three participants revealed for one slot. The first successful Claim occurred 629 L2 blocks after the predetermined entropy block, beyond the old 256-block hash window. The system history hash matched the original RPC block header; the final seed matched the original selection formula; exactly one NFT was minted; losers and duplicate Claim attempts were rejected; no reservations remained. No earlier Finalize or keeper transaction was used.
- Both Worlds use a deliberately fast Custom test schedule: 300 Commit blocks, 300 Reveal blocks, and 1,200 Claim blocks. These are not the Easy / Hard / Hell production timing constants.
- The immutable production presets use a shared 237,600-block Claim window. Full-window settlement and history boundaries are covered locally by `stock-world:block-history-test`; the public-chain delay above is a shorter, real-chain confirmation, not a 6.6-hour live wait.
- The testnet permanent-market stack remains mocked. This recheck does not establish live mainnet V4 graduation execution or eliminate the sequencer-influence limitation of block-hash entropy.

`npm run stock-world:testnet-lottery-smoke-test` runs the same three-participant selection logic locally, including delayed Claim, original-seed comparison, winner/loser checks, and replay without new writes.

`npm run stock-world:testnet-lottery-smoke` is plan-only by default. Approved execution requires `--broadcast --confirm TEST-STOCK-WORLD-DELAYED-LOTTERY-46630`. It binds to the current deployment build, launches one new test World, funds two local test wallets with 0.00001 test ETH each, and caps maximum transaction cost at 0.0008 test ETH by default. Private keys and Mint secrets are separate ignored files with mode 0600. The signed transaction hash is checkpointed before broadcast; recovery checks that same hash rather than automatically sending a second transaction. Completed runs can be rechecked read-only. Inspect any incomplete or uncertain transaction before recovery; a missed Reveal/Claim window cannot be reopened.

For browser integration work, keep the same rehearsal deployment available over a loopback-only JSON-RPC endpoint:

```bash
npm run stock-world:ui-rehearsal
```

The command binds Ganache to `127.0.0.1:8545`, deploys one complete rehearsal World, and prints the temporary Factory address, Factory deployment block, and quote asset address. It does not write an account private key or modify any website configuration. Stop it with `Ctrl+C` and never publish its temporary addresses as production values.
