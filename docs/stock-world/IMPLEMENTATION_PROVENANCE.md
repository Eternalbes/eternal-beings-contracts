# Stock World Implementation Provenance

Stock World is an independent Robinhood Chain protocol with its own contracts,
configuration, reward allocation, NFT system, and public identity.

The pre-graduation market implementation intentionally adapts battle-tested
engineering patterns from the MIT-licensed `ponsdotdev/ponsfamily` V2 contracts,
pinned at commit `e9dfc58128e8534d2e9d4d65be18f1dea32c404f`.

The adapted market properties are:

- constant-product pricing with a virtual quote reserve;
- separately tracked reserves so forced token transfers cannot change pricing;
- fees charged only on the quote-asset leg;
- a reserved token boundary and partial final buy;
- buy and sell closure as soon as graduation becomes ready; and
- graduation state committed before external reserve transfers.

Stock World replaces the upstream fee destinations and launch policy with its
own immutable Token/NFT/Creator reward vault. Native ETH is the canonical
default quote asset; additional ERC-20 quote assets must be admitted through
the protocol registry.
The upstream repository is used as an implementation reference, not as a
runtime dependency or an administrative dependency.

The graduation reserve conversion, full-range liquidity guard, and local
TickMath implementation were independently adapted from the same upstream V2
graduation path and its vendored Uniswap v4 libraries, inspected at commit
`f2e069c1bf26bde0760446ecce3cf2501cf50846`. Stock World adds its own reward
liquidity contribution, so the pool token allocation preserves the terminal
curve price across both swept curve quote and reserved reward quote. Any World
Tokens not needed at that price are sent to the ownerless permanent locker.
Reward quote used by the initial seed is capped at the virtual quote reserve;
larger accumulated reserves remain in the World reward vault for the public
post-graduation forwarding path instead of making graduation impossible.

The isolated Permit2 approval sequence and PositionManager action encoding in
`StockWorldGraduationExecutor` follow the upstream V2 graduation executor
inspected at the same pinned commit. Stock World supports native ETH through
Uniswap v4's native currency path and isolates Permit2 approvals to ERC-20
assets. It pulls only the current World's exact amounts, revokes both approval
layers after minting, returns residuals to the coordinator, locks World Token
dust, and records quote dust against its originating escrow.

`StockWorldHook` retains the pinned reference's Uniswap v4 return-delta fee
mechanism and exact `PoolManager.take` balance checks. Stock World deliberately
uses both before- and after-swap callbacks to charge only the native-ETH or
ERC-20 quote leg in all four exact-input/output directions. This removes the reference design's
World Token conversion, privileged sweep operator, spot-price impact setting,
and buyback path. The resulting fee ledger is pool-isolated, price-independent,
and permissionlessly sweepable into each immutable `WorldRewardVault`.
