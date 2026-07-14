# Eternal Beings Audit Notes

This file tracks design constraints and checks for the current prototype.

## Checked by `npm test`

- Solidity compilation with optimizer, `viaIR`, and Shanghai EVM target.
- Forbidden admin/backdoor keyword scan, including owner/admin minting, withdrawal/rescue/recover paths, delegatecall/selfdestruct, `tx.origin`, `Ownable`, `AccessControl`, and `unchecked`.
- Commit/reveal/claim mint happy path.
- Mint phase boundaries reject early reveal, early claim, wrong secret, duplicate commit, duplicate reveal, duplicate claim, and post-mint recommit.
- Mint commitments cannot be `bytes32(0)`, preventing accidental unrevealable commits.
- Mint release curve is checked at the first tranche, the final partial tranche, and the permanent `MAX_BEINGS` cap.
- Mint claim updates `totalMinted`, `aliveSupply`, reveal count, epoch claim limit, and epoch claimed count.
- One mint per address behavior.
- Hunt locks the NFT in the game contract.
- Non-hunter cannot resolve a Hunt.
- Hunt cannot be resolved in the same block it was entered, preventing zero-block genome/metadata rerolls.
- Hunt resolve returns the NFT.
- Hunt entry clears token approval, and approved/previous owner paths cannot transfer, approve, fuse, or devour the hunting NFT.
- Hunt cooldown blocks immediate re-entry.
- A long Hunt cannot push ORE supply above the emission cap.
- Repeated Hunt loops keep the NFT locked during play, return it on resolve, cap endurance, keep emitted ORE monotonic, and stay below emission/max-supply limits.
- ORE minter is the game contract.
- Non-minter cannot mint ORE.
- ORE total supply does not exceed the global emission cap in tested flow.
- ORE transfer, approve, transferFrom, allowance decrement, zero-address transfer rejection, and insufficient-balance transfer rejection.
- Hunt ORE reward is recomputed in tests from NFT score and scene data, then compared with actual ORE balance.
- Seeded invariant test covers multiple mints, repeated Hunts, external devour, internal fusion burn, ORE caps, live/burned token state, stage bounds, lineage mask bounds, and on-chain SVG metadata.
- Very large attribute values still increase score, but nested square-root scoring soft-caps extreme growth.
- ERC2981 royalty info returns the immutable receiver and 3% royalty amount.
- Unknown ERC721 devour requires real ownership and transfer into the game contract.
- Unknown ERC721 devour does not directly increase Power.
- Devoured ERC721s are owned by the game contract and cannot be transferred out by the former owner in tested flow.
- Native CryptoPunks-style devour requires observation, user-side Punk transfer into the game contract, and finalization.
- Native CryptoPunks-style observations expire after `CRYPTOPUNK_OBSERVATION_BLOCKS`.
- Devoured native CryptoPunks remain owned by the game contract and cannot be transferred out by the former owner in tested flow.
- The same external NFT cannot be devoured twice.
- Internal fusion burns the sacrifice and reduces alive supply.
- Internal fusion inherits both parent and sacrifice `lineageMask` values.
- `safeTransferFrom` works with a valid ERC721 receiver.
- Tiered collection Merkle root is fixed at deployment.
- Tiered collection proof verification accepts the correct tier and rejects a wrong tier.
- Tiered devour proof increases Power for a tier 4 collection.
- Invalid tier proof fails.
- `tokenURI` returns JSON containing an SVG data image.
- `tokenURI` includes `Lineage` and `LineageMask` traits.
- Static checks fail if runtime bytecode or initcode approaches Ethereum deployment limits.
- Contract ABI has no tested rescue, withdrawal, recover, execute, or external-transfer style function.
- Collection compatibility script found the corrected special set: CryptoPunks requires an adapter; CryptoKitties, Autoglyphs, and KnownOrigin were removed; corrected replacement entries tested as direct ERC721.

## Important remaining work before mainnet

- Replace `data/top-collections.sample.json` with the final immutable collection list.
- Independently review the final Merkle root before deployment.
- Reconfirm the production royalty receiver before deployment; it is immutable.
- Remember ERC2981 royalties are marketplace metadata, not universal forced payment.
- CryptoKitties was removed from the curated collection root because it is non-standard.
- Autoglyphs and KnownOrigin were removed from the curated collection root because they require extra legacy-contract review.
- Expand invariant/property tests toward larger multi-user runs, long-running emission horizons, mint quota exhaustion, and random scene boundaries.
- Renderer and game bytecode are near the project warning thresholds; future visual/gameplay additions should first remove or compress existing code.
- Current static check warning thresholds are `23000` runtime bytes and `48000` initcode bytes.
- External Solidity audit is optional for this small unaudited experiment, not a deployment blocker. If skipped, rely on expanded internal tests, testnet rehearsal, and clear risk disclosure.
