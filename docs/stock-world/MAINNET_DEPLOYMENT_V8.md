# Stock World V2 Mainnet Deployment

Deployed on 2026-09-30 to Robinhood Chain mainnet, chain ID **4663**.

Website: https://eternalbeings.space/stock-world/

Factory: https://robinhoodchain.blockscout.com/address/0x6d1C0392Df969a52A860b0f7836fe8b014b71eb5

Factory deployment block: **76,198,366**.

## Shared Contracts

| Module | Address |
| --- | --- |
| Factory | `0x6d1C0392Df969a52A860b0f7836fe8b014b71eb5` |
| Quote asset registry | `0x9e9ebcD77fa4d10E18C90211FE016266d3368805` |
| Config validator | `0xE715eb3dea99FB51A2982e307e781e2F860A745F` |
| Core deployer | `0xEE0Bb120c0edA1c64E41EE89060C3EE0DB5E3999` |
| NFT deployer | `0x7418Bb7A8e3b1dd37EDCBa5E4b2D343107B379D8` |
| Launch deployer | `0x83409751A011389E27F8D89A777eab1B2eD4E5af` |
| Renderer | `0xFeDA2acb2b0AA10F721f0e1b61834F24260a3C3E` |
| Graduation coordinator | `0x4298A3b1b36ee1BC820444964CD498624E4a6BBe` |
| Graduation guard | `0x152f5E82f0bd40d4fE11F7Df17b6B24ca1838016` |
| Liquidity locker | `0x3cf92C664Fedf1aAd4FA720efbE27c1E85beC23B` |
| Hook | `0xac39c037B552FB225E5aAB38561F403B2d0420Cc` |
| Hook deployer | `0xc0a492A6274c7D242704340F71A836B2f45e1e5e` |

## Verification Performed

- All 24 deployment, binding, and registration receipts succeeded.
- All 12 deployed runtime hashes match the checkpointed deployment records.
- One-time Factory/Coordinator and Hook/Coordinator bindings were checked.
- ETH plus USDG, SPY, QQQ, MSFT, META, AMZN, GOOGL, NVDA, AAPL, and TSLA are enabled. Asset addresses and exact graduation economics are recorded in `config/stock-world.production.json`.
- ETH remains the default quote asset, with a 4.2 ETH graduation threshold.
- Actual deployment Gas cost: **0.000535676541134 ETH**, below the authorized **0.002 ETH** hard limit.
- No Worlds were created, no trading was performed, and no user assets were approved or NFTs burned during this mainnet deployment.
- Desktop and mobile website checks passed with signing disabled: mainnet connection, asset selection, graduation targets, Mint presets, Custom Claim bounds, creator fee cap, wallet reads, and layout.
- Only the V2 website configuration changed. V1 served files were checked against their unchanged local release. Previous immutable Factories and Worlds remain intact.

## Formal Mint Presets

| Difficulty | Commit blocks | Reveal blocks | Claim blocks | Slots per epoch | Wallet limit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Easy | 158,400 | 79,200 | 237,600 | 999 | 1 |
| Hard | 316,800 | 158,400 | 237,600 | 666 | 1 |
| Hell | 633,600 | 316,800 | 237,600 | 333 | 1 |

Custom Claim is bounded to 1,200-237,600 blocks. Wall-clock durations are estimates from observed L2 cadence, not fixed hours. Claim deadlines remain anchored to each epoch, not the time of settlement.

## Limitations

This is deployment verification, not a claim that the protocol has no bugs. Full graduation against the live mainnet DEX has not been exercised. The source-attested V4 dependencies are third-party deployments; they are not represented as official Uniswap deployments. Browser checks were read-only on mainnet; the prior full transaction lifecycle was tested on Robinhood testnet.

All 12 shared contracts and all 7 modules of World #0 received exact creation/runtime source matches on Sourcify on 2026-09-30. See [source verification](SOURCE_VERIFICATION_V8.md) for links and automatic verification scope. Blockscout's local Verified badge is a separate index; this document does not assert that all explorer badges have propagated.
