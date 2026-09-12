# Eternal Beings

Prototype for a no-owner, non-upgradeable on-chain NFT game.

The intended production shape can be contract-only: no official UI, no server, no admin panel, and no off-chain renderer. Players interact through explorers, wallets, scripts, or community-built tools.

## 3D world concept demo

The public [Eternal Beings 3D World Demo](https://eternalbeings.space/world-demo/) shows how the Ethereum instance can act as an open data layer for community-built games and interfaces. It reads a Being's live public contract state and deterministically projects its Genome, Lineage, Stage, Power, Skill, Mass, and Complexity into an interactive Three.js character.

The current combat, evolution, hybrid, and ORE feedback are clearly labeled local simulations. They do not connect a wallet, submit transactions, mint ORE, or modify Ethereum state. Source and local instructions are available in [`demos/world-demo`](demos/world-demo/README.md).

## Stock World protocol architecture

The proposed V2 architecture extends the world-launching model with a fixed-supply World Token, a fair World NFT launch, Fusion, quote-denominated fee rewards, a graduation path into permanently locked liquidity, and public interfaces for independent games and applications.

- [Read the Stock World Protocol V2 architecture](docs/stock-world/Stock-World-Protocol-V2-Architecture.md)
- [Track the Stock World Protocol V2 implementation](docs/stock-world/IMPLEMENTATION_STATUS.md)

## EB-ZEC Zcash protocol draft

This repository also publishes an independent research track for bringing Eternal Beings to Zcash as a shielded memo inscription protocol. It is separate from the deployed Ethereum contracts in this repository and is not yet a live Zcash product.

- [Read the EB-ZEC whitepaper](docs/zcash/EB-ZEC-Protocol-Whitepaper-v1.0.md)
- [Download the whitepaper PDF](docs/zcash/EB-ZEC-Protocol-Whitepaper-v1.0.pdf)
- [Read the normative memo inscription protocol](docs/zcash/EB-ZEC-Memo-Inscription-Protocol-v1.md)
- [Download the machine-readable JSON Schema](docs/zcash/eb-zec-v1.schema.json)
- [Download from the official website](https://eternalbeings.space/EB-ZEC-Protocol-Whitepaper-v1.0.pdf)

EB-ZEC uses signed canonical JSON messages in encrypted Zcash memos. The draft defines `mint-commit`, `mint-reveal`, `transfer`, `hunt-start`, `hunt-resolve`, `mutate`, `consume-permit`, `devour`, `fuse`, `list`, `cancel`, `buy`, and `payment-ack`. Independent indexers apply the same deterministic rules, while a reproducible renderer derives artwork and metadata from canonical Being state.

Core rules included in `src/EternalBeings.sol`:

- 9999 Genesis NFT supply.
- Commit/reveal/claim mint flow.
- One mint per address.
- Dynamic on-chain SVG metadata from genome/state.
- ERC2981 royalty info returns a fixed 3% royalty to the immutable deployment-time receiver.
- External ERC721 devour: locked forever in the game contract.
- Native CryptoPunks-style devour: observe, user transfers the Punk into the game contract, then finalize devour.
- Internal Being fusion: sacrifice is burned, parent inherits state.
- Being fusion and mutation use a compressed `lineageMask`, allowing hybrid/chimera/Omega visual families without unbounded storage growth.
- Hunt as dungeon staking: NFT transfers into the contract and returns on resolve.
- Standard ERC20-style `EternalOre` token deployed by the game constructor.
- Game contract is the only ORE minter, with a fixed max supply of 21,000,000.
- 300-year global emission curve at about 0.0266 token per block.
- Hunt rewards are based on NFT attributes and scene difficulty, then capped by the global per-block ORE emission curve.
- No owner, no upgrade, no pause, no rescue, no admin mint.
- ERC2981 royalties are advisory marketplace metadata; the contract cannot force every private or non-compliant sale to pay royalties.

This is an unaudited experimental contract-only game. It is intended as a small permanent on-chain artifact, not a professionally audited large-scale protocol. Interact at your own risk.

## Security assumptions locked into the prototype

- Unknown external NFTs do not directly increase Power or Skill.
- Unknown external NFTs only add very small Mass/Complexity and mutation chance.
- Unknown external NFTs must be observed first, wait `UNKNOWN_HOLD_BLOCKS`, support ERC721, expose `totalSupply()`, meet `UNKNOWN_MIN_TOTAL_SUPPLY`, and stay under the per-collection unknown devour cap.
- Power/Skill primarily come from Hunt, top-tier collections, and internal fusion.
- A devoured external NFT must be owned by the caller before devour and owned by the game contract after devour.
- A native CryptoPunk must be observed by its owner, transferred by that owner into the game contract, and then finalized before it affects the Being.
- Native CryptoPunk observations expire after `CRYPTOPUNK_OBSERVATION_BLOCKS` to prevent stale observations from remaining usable forever.
- Each external `(collection, tokenId)` can only be devoured once.
- There is no rescue or withdrawal function for devoured external NFTs or native CryptoPunks.
- Hunt transfers the Being into the game contract and records the original hunter.
- Hunt state is deleted before rewards are minted or the NFT is returned.
- ORE emission is capped by both max supply and the global per-block release curve.
- Hunt score uses a nested square-root soft cap over Power, Skill, Complexity, and Mass, so long-running fusion growth remains useful but has diminishing reward impact.
- Top-tier collections use an immutable deployment-time Merkle root.
- Unknown collections use `devourExternal()` and tier `0`.
- Top-100 collections use `devourTieredExternal()` with a `(collection, tier)` Merkle proof.
- Curated collection tiers:
  - Rank 1-10: tier 5, strongest
  - Rank 11-30: tier 4
  - Rank 31-50: tier 3
  - Rank 51-70: tier 2
  - Rank 71-100: tier 1, only about 3x stronger than ordinary NFTs
- The current 100-collection list was checked against Ethereum RPC with `scripts/check-collections.js`.
- Known non-standard adapter collection: native CryptoPunks.
- CryptoKitties was removed from the curated root because it is non-standard.
- Autoglyphs and KnownOrigin were removed from the curated root to avoid legacy-contract review risk.

Generate a deployment root and per-collection proofs with:

```bash
node scripts/generate-tier-root.js data/top-collections.ethereum.curated.json reports/top-collections.proofs.json
node scripts/verify-proof-file.js reports/top-collections.proofs.json 0xcfd388334a04e188055199c93b09e9b65ff5e742380b7aecbd5d46c05e51358f
```

Deploy `EternalBeings` with the generated `root` and the immutable royalty receiver as constructor arguments.
For local testing without top-tier collections, pass:

```text
root: 0x0000000000000000000000000000000000000000000000000000000000000000
royaltyReceiver: your royalty receiving address
```

Run checks with:

```bash
npm test
```

Run a local deployment rehearsal that starts Ganache, calls `deploy.js`, and verifies the result with `postdeploy-check.js`:

```bash
npm run local-rehearsal
```

Generate a local readiness snapshot with:

```bash
npm run readiness-report
```

For contract-only play through explorers, wallets, or scripts, see `CONTRACT_INTERACTION.md`.
For unaudited pre-mainnet rehearsal, see `TESTNET_REHEARSAL.md`.
For the shortest testnet deployment path, see `TESTNET_QUICKSTART.md`.
For the current Sepolia deployment, see `TESTNET_DEPLOYMENT.md`.

Build a deployment readiness report with:

```bash
WRITE_ARTIFACTS=1 node scripts/compile.js
node scripts/deployment-report.js data/top-collections.ethereum.curated.json 0xYOUR_ROYALTY_WALLET reports/deployment-mainnet.json
```

Deploy with explicit constructor arguments:

```bash
node scripts/deploy.js $RPC_URL $PRIVATE_KEY 0xEXPECTED_ROOT 0xROYALTY_RECEIVER
```

Prepare block-explorer verification files with:

```bash
node scripts/prepare-verify.js 0xEXPECTED_ROOT 0xROYALTY_RECEIVER 0xRENDERER reports/verify
```

Check the collection list against Ethereum RPC with:

```bash
node scripts/check-collections.js data/top-collections.ethereum.curated.json reports/collection-check.ethereum.json
```

After deployment, run the read-only contract self-check with:

```bash
node scripts/postdeploy-check.js $RPC_URL 0xGAME 0xEXPECTED_ROOT 0xROYALTY_RECEIVER
```

`src/TestExternalNFT.sol`, `src/TestCryptoPunks.sol`, and `src/TestERC721Receiver.sol` are test mocks only and are not part of the production deployment.
