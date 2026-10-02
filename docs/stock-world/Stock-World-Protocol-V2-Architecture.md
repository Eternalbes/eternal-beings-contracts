# Stock World Protocol V2 Architecture

Version: Draft 0.1

Status: Architecture proposal, not deployed production contracts

Network target: Robinhood Chain

## 1. Purpose

Stock World Protocol V2 extends the V1 world-launching model into a complete on-chain economy. Each World combines a fixed-supply fungible token, a fair NFT collection, an evolving NFT weight system, a quote-asset market, transparent fee distribution, and permanently locked post-graduation liquidity.

The protocol separates immutable World rules from replaceable interfaces. Websites, games, dashboards, indexers, and AI agents can read the same contracts without becoming part of the trust path.

Stock World is an experimental protocol name. A World Token or World NFT does not represent company equity, legal shares, voting rights, guaranteed income, or ownership of the issuer represented by a paired asset.

## 2. Design Goals

- Launch a World Token and World NFT economy in one deterministic flow.
- Give participants separate liquid-token and scarce-NFT entry paths.
- Distribute real quote-asset fees without inflationary reward emissions.
- Prevent new participants from claiming rewards generated before eligibility.
- Keep launched World economics immutable.
- Make graduation retryable and prevent stranded reserves.
- Permanently lock graduated liquidity with no withdrawal path.
- Avoid loops over token holders or NFTs during fee distribution.
- Expose complete on-chain state through stable public interfaces and events.
- Keep platform governance unable to alter an already launched World.

## 3. System Topology

![Stock World Protocol V2 architecture topology](./Stock-World-Protocol-V2-Topology.svg)

```text
                         StockWorldFactory
                                |
               +----------------+----------------+
               |                                 |
       Shared Infrastructure              Per-World Contracts
               |                                 |
       QuoteAssetRegistry                  WorldToken
       StockWorldHook                      BondingCurve
       GraduationGuard                    WorldNFT
       GraduationExecutor                 WorldRewardVault
       LiquidityLocker                    FairMintController
       PlatformRevenueVault
```

Shared contracts serve every World. Per-World contracts isolate balances, accounting, parameters, and failure domains between launches.

## 4. Immutable Launch Configuration

```solidity
struct WorldConfig {
    string name;
    string symbol;
    address quoteAsset;
    address creator;
    uint256 graduationTarget; // must equal the selected asset registry preset
    uint32 nftMaxSupply;
    uint16 tokenHolderBps;
    uint16 nftHolderBps;
    uint16 creatorBps;
}
```

Initial protocol constraints:

- World Token supply: `1,000,000,000` fixed units, matching the canonical PONS launch supply.
- World NFT maximum supply: `100` to `10,000`.
- Preset NFT wallet allocation limit: `1` lifetime mint per wallet.
- Base trading fee: `1%` of the quote leg.
- Default fee allocation: `40%` Token / `40%` NFT / `20%` Creator.
- Creator allocation cap: `80%`.
- Allocation invariant: all World fee shares total exactly `10,000` basis points.
- Platform launch fee: `0.0003 ETH`, with gas paid separately.
- The quote asset selects protocol-controlled phantom-reserve and graduation presets. Creators cannot invent their own target. The selected economics, fee allocation, and supply rules become immutable at launch.

## 5. Shared Contracts

### 5.1 StockWorldFactory

The factory validates configuration, collects the fixed launch fee, deploys the per-World stack, records canonical addresses, and coordinates graduation. It is the registry entry point for indexers and interfaces.

The factory may publish new templates for future Worlds, but it cannot alter existing deployments. Protocol revisions use a new factory instead of upgrading launched Worlds.

### 5.2 QuoteAssetRegistry

The registry contains canonical quote assets approved for new launches. An approved asset must have known decimals and standard ERC-20 transfer behavior. Fee-on-transfer, rebasing, callback-driven, blocklisted, or otherwise incompatible assets must be rejected.

Registry changes affect only future launches. A time-locked multisignature may maintain the registry until a credible permissionless policy is available.

### 5.3 StockWorldHook

The singleton Uniswap v4 hook collects the post-graduation fee only in the World's quote asset. A combined `beforeSwap` and `afterSwap` delta design covers quote-specified and quote-unspecified swaps, so the hook never accumulates World Token inventory and never needs a price oracle, privileged conversion operator, or manipulable internal swap. Anyone may sweep the exactly tracked quote balance into that World's reward vault.

The hook accepts registrations only from the immutable graduation coordinator and verifies the coordinator's canonical factory and World record. Its `beforeInitialize` callback accepts only that coordinator, preventing an unrelated account from pre-initializing a canonical pool. Its address must encode the required Uniswap v4 hook permission bits and must be deployed through a reproducible CREATE2 process.

### 5.4 GraduationGuard and GraduationExecutor

The guard preflights pool creation using the actual launch configuration and current quote-asset state. The executor creates the full-range Uniswap v4 position, sends it directly to the locker, and returns harmless dust according to fixed rules.

The purchase that exhausts the curve attempts both graduation phases automatically. Failure is isolated from the purchase, leaves the curve graduation-ready, and preserves the permissionless, retryable `prepareGraduation` and `completeGraduation` fallback. A failed pool-creation transaction must not make collected reserves unreachable.

### 5.5 LiquidityLocker

The locker permanently owns each graduated position. It exposes no withdrawal, rescue, arbitrary-call, approval, or timed-unlock path. Neither the creator, platform, nor registry administrator can recover the position.

### 5.6 PlatformRevenueVault

The platform vault receives fixed launch fees. A future ENDSZ buyback module may spend a disclosed portion through a permissionless, TWAP-protected execution function. The initial release must not promise a buyback percentage until that percentage, venue, slippage policy, and destination are frozen in code.

## 6. Per-World Contracts

### 6.1 WorldToken

WorldToken is a standard fixed-supply ERC-20. It has no post-launch minting, freezing, blacklisting, confiscation, or administrator transfer function. The entire market allocation is delivered to the bonding curve at creation.

The curve, pool, locker, burn address, reward vault, and protocol-owned addresses are excluded from participant reward weight.

### 6.2 BondingCurve

The curve provides pre-graduation buying and selling against the selected quote asset. A constant-product model with a virtual quote reserve establishes the opening price:

```text
quoteReserve * tokenReserve = k
```

Native ETH uses the canonical PONS economics: a 1.68 ETH phantom reserve and a 4.2 ETH graduation threshold. Approved ERC-20 quote assets receive protocol-controlled values in their registry entry. The curve reserves the World Token allocation implied by those two values, applies deadline and minimum-output protection, collects the 1% quote-leg fee, and deposits fees into the WorldRewardVault. It closes permanently when graduation begins.

Stock World intentionally has no Hunt or gameplay token-emission path. World Token supply is fixed and enters the bonding-curve lifecycle; NFTs evolve through Fusion and receive trading-fee weight.

### 6.3 WorldNFT

WorldNFT is an ERC-721 collection with immutable supply rules and mutable on-chain evolution state:

```solidity
struct WorldBeing {
    uint128 weight;
    uint64 fusionCount;
    uint256 rewardDebt;
    bytes32 genome;
}
```

The contract exposes ownership, weight, fusion count, genome, metadata, and standard transfer interfaces. Every transfer settles the sender's accrued NFT rewards before ownership changes. The recipient becomes eligible only from the current reward index.

### 6.4 FairMintController

NFT distribution follows repeating Commit, Reveal, and Claim phases. Commitments hide participant secrets during entry. Claim automatically combines revealed entropy with the predetermined future L2 block hash and settles an unfinalized epoch. Users do not need a separate Finalize transaction or a keeper.

The creator selects one immutable Mint difficulty at launch. Presets are generated by protocol constants, so a caller cannot label a modified schedule as Easy, Hard, or Hell:

| Difficulty | Commit | Reveal | Claim window | Maximum per epoch | Wallet limit |
|---|---:|---:|---:|---:|---:|
| Easy | 158,400 blocks | 79,200 blocks | 237,600 blocks | 999 | 1 |
| Hard | 316,800 blocks | 158,400 blocks | 237,600 blocks | 666 | 1 |
| Hell | 633,600 blocks | 316,800 blocks | 237,600 blocks | 333 | 1 |

At the latest observed Robinhood Chain cadence, the preset epoch lengths are approximately 6.8, 13.6, and 27.2 hours. Wall-clock time varies with block cadence; the immutable rules use the Robinhood L2 block number exposed by the Arbitrum `ArbSys` precompile, not the parent-chain value returned by Solidity's native `block.number`. If a collection supply is smaller than a preset's per-epoch maximum, the effective capacity is capped at that collection supply. With the default 9,999 NFT supply, the theoretical minimum distribution is 11 Easy epochs, 16 Hard epochs, or 31 Hell epochs; low participation and expired claims can extend it.

All presets share a 237,600-block Claim window, approximately 6.6 hours at 0.1 seconds per block. This replaces the longer historical Hard/Hell Claim windows without changing Commit/Reveal duration or epoch capacity. Custom mode lets the creator set Commit, Reveal, Claim, epoch capacity, and wallet limit. The Factory bounds Custom Claim to 1,200-237,600 blocks, requires capacity not to exceed NFT supply, limits a custom wallet allocation to at most 10, and commits every value into the immutable launch hash. Stock World keeps no Hunt, endurance, or token-emission difficulty fields.

Each revealer receives a sequential index. Finalization derives a random starting index and selects one circular interval containing exactly the smaller of the epoch capacity, revealed count, and globally unreserved supply. Winner status is therefore independent of claim order and requires no loop over participants.

Finalized winners reserve supply only until the epoch-fixed deadline at `entropyBlock + claimBlocks`. Delaying finalization cannot extend or reopen that window. Anyone may expire an unclaimed epoch afterward, returning unused reservations to later epochs. The controller enforces the historical wallet allocation limit, rejects duplicate commitments, naturally expires unrevealed entries, and never restores mint capacity when an NFT is later burned in Fusion.

The controller reads the canonical ArbOS history system contract at `0x0000F90827F1C53a10cb7A02335B175320002935`, not just ArbSys's 256-block lookup. Its pinned runtime serves 393,168 L2 block hashes, covering the entire maximum Claim window with margin. A first successful Claim near the deadline can therefore settle an oversubscribed epoch using the same fixed target hash as an immediate settlement, with no operator, timer transaction, archive-proof input, or new oracle fee. Mainnet/testnet deployment checks attest its runtime, L2 clock, and (for production) a full-window historical hash against RPC block data. Controllers on Robinhood reject deployment if that runtime is absent or different.

If the history source becomes unavailable, a predictable fallback never decides a scarce allocation: an epoch needing a lottery expires without reservations. All-revealer allocations may still use a deterministic artwork-only seed before their unchanged deadline. History cannot reopen expired Claim windows. The system still requires user transactions and is not VRF-grade randomness: the sequencer/block producer can influence block hashes. This fixes the short settlement window, not Sybil resistance or sequencer-independent randomness. Existing immutable Worlds are unchanged; the revised policy requires a new Factory and newly launched Worlds.

Reward checkpoints store the last settled index (the historical ABI field name remains `rewardDebt`). Rewards accrue from `weight * (currentIndex - checkpointIndex)`, with sub-unit remainders retained per beneficiary. Mint, activation, withdrawal, transfer, and Fusion cannot assign fractional rewards from before the beneficiary joined. NFT fractions already earned stay with the previous beneficiary on transfer. `pendingNftReward(tokenId)` reports whole unsettled token rewards; settling can also realize a beneficiary's carried fraction.

### 6.5 WorldRewardVault

The reward vault receives quote assets from both the curve and the graduated pool. Each deposit is divided according to the immutable World configuration:

```text
World fee
  |-- Token reward allocation
  |-- NFT reward allocation
  `-- Creator claimable balance
```

Distribution uses cumulative indices rather than holder iteration:

```text
tokenRewardPerShare += tokenFee * 1e27 / eligibleTokenWeight
nftRewardPerWeight  += nftFee   * 1e27 / totalNFTWeight
```

Claims use a pull model. External transfers occur only after accounting state is updated and are protected against reentrancy.

## 7. Token Reward Eligibility

The recommended first release uses a TokenRewardVault rather than automatic wallet-balance rewards. Users stake World Tokens to receive future quote-asset fees. Stake activation begins in the next block, preventing same-block deposit-and-claim strategies. Unstaking settles rewards before principal is returned.

This design avoids adding reward accounting to every ERC-20 transfer and reduces temporary-balance and flash-liquidity attacks. Staking never mints additional World Tokens.

## 8. NFT Reward Accounting

NFTs receive rewards according to their active weight. A newly minted NFT records the current `nftRewardPerWeight` and cannot claim historical fees. Before transfer, burn, or Fusion, the contract settles all rewards earned under the previous owner and weight.

After transfer, future rewards follow the NFT. Previously accrued rewards remain claimable by the previous owner.

## 9. Fusion

Fusion uses a parent-and-sacrifice model:

```text
Parent NFT + Sacrifice NFT -> Evolved Parent NFT
```

Both NFTs must be owned or approved by the caller. The protocol settles both reward positions, burns the sacrifice, increases the parent's weight, updates its genome and fusion count, and sets its reward debt to the current index.

The initial weight rule is:

```text
newWeight = parentWeight + sacrificeWeight + 1
```

Thus `1 + 1` becomes `3`. Fusion processes one pair per transaction and does not provide a batch path.

## 10. Zero-NFT Reserve

If trading begins before any World NFT exists, the NFT fee allocation enters a visible zero-NFT reserve. It is never creator or platform revenue.

Before the first mint, anyone may permanently commit the reserve to the World's locked-liquidity allocation. If the first NFT is minted while the reserve is nonzero, the mint transaction commits it automatically. The first NFT participates only in fees deposited after its reward-index checkpoint.

After graduation, committed quote reserves remain attributed to their originating World in the immutable graduation coordinator as a permanent reserve sink. They are never converted, distributed, claimable, or withdrawable. Converting them against the same pool using a caller-selected minimum output or a same-block spot price would make a permissionless maintenance call sandwichable; assigning them to later Token or NFT holders would instead create a timing windfall. The on-chain constant `POST_GRADUATION_QUOTE_PERMANENTLY_LOCKED` exposes this terminal policy to interfaces and indexers. The historical `pendingQuoteByEscrow` ABI name is retained for compatibility, but it records locked attribution rather than a future claim.

## 11. Fee Flow

Before graduation:

```text
Trader -> BondingCurve -> WorldRewardVault -> Token / NFT / Creator ledgers
```

After graduation:

```text
Trader -> Uniswap v4 Pool -> StockWorldHook
       -> exact quote-asset fee accounting
       -> permissionless sweep
       -> WorldRewardVault -> Token / NFT / Creator ledgers
```

Rewards and creator payouts are always denominated in the World's selected quote asset. No oracle is required for curve pricing or fee settlement.

## 12. World Lifecycle

```text
CONFIGURED
    -> CURVE_LIVE
    -> GRADUATION_READY
    -> RESERVES_SWEPT
    -> V4_POOL_CREATED
    -> PERMANENT_MARKET
```

Each phase transition is monotonic. Trading routes must read the authoritative phase instead of inferring it from balances. Recovery from a failed graduation attempt may retry the same transition but cannot return the World to curve trading.

## 13. Permission Model

After launch, no privileged account may:

- Increase World Token or NFT maximum supply.
- Change the quote asset or its snapshotted graduation economics.
- Change the fee rate or allocation.
- Withdraw liquidity or zero-NFT reserves.
- Rewrite curve pricing.
- Freeze transfers or confiscate participant assets.
- Grant historical rewards to a new participant.
- Replace the World's contracts.

The creator may update only non-economic metadata and the address receiving future creator rewards, if those capabilities are explicitly enabled at launch.

## 14. Required Events and Read Interfaces

Core events include `WorldCreated`, `CurveTrade`, `FeeDeposited`, `RewardClaimed`, `MintCommitted`, `MintRevealed`, `NFTClaimed`, `Fused`, `GraduationStarted`, `PoolCreated`, `LiquidityLocked`, and `ZeroNftReserveCommitted`.

Public views must expose World configuration, lifecycle phase, canonical contract addresses, curve reserves, sellable supply, graduation progress, pool identity, fee indices, total NFT weight, zero-NFT reserve, and claimable balances.

These interfaces are the integration surface for independent UIs, games, analytics systems, and agents.

## 15. Security Invariants

- World Token total supply never exceeds the launch constant.
- Minted NFT count never exceeds the configured cap.
- Finalized NFT reservations plus historical mints never exceed the configured cap.
- Exactly the configured number of eligible winner indices is selected when sufficient revealers and supply exist.
- Claim order cannot turn a non-winning reveal into a winning reveal.
- Fusion never increases NFT count.
- A burned NFT can never become active again.
- Fee allocations always equal the assets received, excluding bounded rounding dust.
- Claimed rewards never exceed deposited rewards.
- A position cannot claim rewards from before its eligibility checkpoint.
- Total active NFT weight equals the sum of live NFT weights.
- Curve reserves cannot be swept before graduation conditions are met.
- Graduation reserves remain recoverable by retry until pool creation succeeds.
- Locked liquidity has no withdrawal path.
- Every external asset transfer follows checks-effects-interactions and uses safe transfer semantics.
- Every user trade includes deadline and slippage limits.

## 16. Deployment Layout

```text
src/stock-world/
|-- StockWorldFactory.sol
|-- StockWorldLaunchDeployer.sol
|-- StockWorldBondingCurve.sol
|-- StockWorldToken.sol
|-- StockWorldNFT.sol
|-- StockWorldFairMint.sol
|-- StockWorldRewardVault.sol
|-- StockWorldTokenRewardVault.sol
|-- StockWorldQuoteRegistry.sol
|-- StockWorldGraduationGuard.sol
|-- StockWorldGraduationExecutor.sol
|-- StockWorldLiquidityLocker.sol
|-- StockWorldHookDeployer.sol
|-- StockWorldHook.sol
|-- StockWorldPlatformRevenueVault.sol
|-- interfaces/
|   |-- IStockWorldFactory.sol
|   |-- IStockWorldRewardVault.sol
|   |-- IStockWorldHook.sol
|   `-- IStockWorldGraduation.sol
`-- libraries/
    |-- StockWorldCurveMath.sol
    |-- StockWorldGraduationMath.sol
    `-- StockWorldRewardMath.sol
```

The system is separated into multiple contracts to preserve ownership boundaries, isolate high-value accounting, and remain below EIP-170 bytecode limits.

## 17. Implementation Sequence

1. Freeze the curve, graduation, liquidity, fee, NFT, and permission specifications.
2. Implement and test the World Token and curve in isolation.
3. Implement the reward vault and prove fee conservation invariants.
4. Add World NFT, fair mint, transfer settlement, and Fusion.
5. Integrate pre-graduation fee deposits.
6. Integrate the v4 hook.
7. Integrate the guard, executor, and permanent locker.
8. Permanently lock quote-only post-graduation reserves with attributable accounting and no conversion or withdrawal path.
9. Add the platform revenue vault without enabling an undefined buyback policy.
10. Run unit, fuzz, invariant, adversarial-token, reentrancy, rounding, and lifecycle tests.
11. Deploy a fast-parameter test instance on Robinhood Chain.
12. Exercise launch, trading, mint, transfer, Fusion, claims, graduation, v4 trading, and failed-graduation recovery.
13. Freeze production parameters and deploy a new immutable production factory.

## 18. Release Boundary

This document defines the intended architecture. The existing Stock World interface is an economic-flow demonstration and does not prove that these contracts have been implemented, reviewed, or deployed. Production claims must begin only after source publication, reproducible builds, test evidence, verified deployments, and a public parameter manifest are available.
