# Contract Parameter Profiles

The project keeps two parameter profiles:

- `config/contract-params.mainnet.json`: production values for Ethereum mainnet.
- `config/contract-params.testnet-fast.json`: fast public-testnet values for immediate rehearsal.

Apply a profile before compiling:

```bash
node scripts/apply-contract-params.js mainnet
WRITE_ARTIFACTS=1 node scripts/compile.js
```

```bash
node scripts/apply-contract-params.js testnet-fast
WRITE_ARTIFACTS=1 node scripts/compile.js
```

Use `mainnet` before any mainnet deployment.

Use `testnet-fast` only for testnet rehearsal. It shortens mint phases and waiting periods so commit/reveal/claim, hunt, external devour, and fusion can be tested quickly.

Only `testnet-fast` sets `UNKNOWN_HOLD_BLOCKS = 0`, so ordinary ERC721 external NFTs can be observed and devoured immediately during rehearsal. The `mainnet` profile keeps the 7200-block hold. The ERC721 check, total-supply gate, owner check, codehash check, and per-collection devour cap remain in both profiles.
