# Eternal Beings Contract Interaction

This project can run without an official UI. The contract is the game surface.

## Mint

Read the current mint phase:

```bash
node scripts/mint-status.js $RPC_URL 0xGAME 0xYOUR_ADDRESS
```

1. Choose a private `secret`.
2. Compute:

```text
commitment = keccak256(abi.encodePacked(userAddress, currentEpoch, secret))
```

Helper:

```bash
node scripts/mint-commitment.js 0xYOUR_ADDRESS EPOCH "your private secret"
```

3. During the commit phase, call:

```text
commitMint(commitment)
```

4. During the reveal phase, call:

```text
revealMint(epoch, secret)
```

5. After the epoch ends, call:

```text
claimMint(epoch)
```

## Hunt

Read a Being state:

```bash
node scripts/being-status.js $RPC_URL 0xGAME TOKEN_ID
```

```text
enterHunt(tokenId)
resolveHunt(tokenId)
```

The NFT is transferred into the game contract while hunting. Only the recorded hunter can resolve it.

## Fuse Beings

```text
fuseBeing(parentId, sacrificeId)
```

Both Beings must be owned by the caller and not hunting. The sacrifice is burned permanently.

## Devour Unknown ERC721

Read unknown external devour readiness:

```bash
node scripts/external-devour-status.js $RPC_URL 0xGAME 0xNFT TOKEN_ID 0xYOUR_ADDRESS
```

```text
observeExternal(nft, tokenId)
```

Wait `UNKNOWN_HOLD_BLOCKS`, approve the game contract on the external NFT, then call:

```text
devourExternal(beingId, nft, tokenId)
```

The external NFT is transferred into the game contract and intentionally has no rescue path.

## Devour Top-100 ERC721

Use the final Merkle proof for `(collection, tier)`:

```text
devourTieredExternal(beingId, nft, tokenId, tier, proof)
```

Helper:

```bash
node scripts/proof-for-collection.js 0xCOLLECTION_ADDRESS
```

## Devour Native CryptoPunks-Style NFT

Read native CryptoPunks-style devour readiness:

```bash
node scripts/cryptopunk-status.js $RPC_URL 0xGAME 0xPUNK_CONTRACT PUNK_ID 0xYOUR_ADDRESS
```

```text
observeCryptoPunk(punkContract, punkId, tier, proof)
```

Transfer the Punk into the game contract through the Punk contract, then call:

```text
devourCryptoPunk(beingId, punkContract, punkId)
```

The observation expires after `CRYPTOPUNK_OBSERVATION_BLOCKS`.

## View State

```text
ownerOf(tokenId)
getBeing(tokenId)
tokenURI(tokenId)
ore()
totalEmitted()
emittedCap()
availableEmission()
```

`tokenURI()` returns on-chain JSON with an on-chain SVG image.

Decode metadata and optionally write SVG:

```bash
node scripts/token-metadata.js $RPC_URL 0xGAME TOKEN_ID reports/token-TOKEN_ID.svg
```

## ORE

`EternalOre` is deployed by the game contract. The game is the only minter. ORE can be transferred and approved like a minimal ERC20-style token.

Read ORE state:

```bash
node scripts/ore-status.js $RPC_URL 0xGAME 0xACCOUNT 0xSPENDER
```

## Important

There is no owner, no pause, no upgrade, no withdrawal, and no rescue. Wrong deployment parameters or a bad collection root cannot be fixed after deployment.
