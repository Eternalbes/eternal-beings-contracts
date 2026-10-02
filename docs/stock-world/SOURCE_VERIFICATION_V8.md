# Stock World V8 Source Verification

Robinhood mainnet (4663), Factory `0x6d1C0392Df969a52A860b0f7836fe8b014b71eb5`.

On 2026-09-30, all 12 shared contracts and all 7 modules of World #0 were verified by Sourcify with **exact creation and runtime matches**. This includes FIRST's ERC-20 and NFT contracts. Verification is not a security audit.

- [Factory source](https://repo.sourcify.dev/4663/0x6d1C0392Df969a52A860b0f7836fe8b014b71eb5)
- [FIRST token source](https://repo.sourcify.dev/4663/0x283Ca093c95d06F04faD02D711B4c9bF07091B50)
- [FIRST NFT source](https://repo.sourcify.dev/4663/0xff04795cF48062f02b6ad1bab6E7e3055BAa97a5)

## Existing Worlds

Run from the contract repository:

```sh
npm ci
WRITE_ARTIFACTS=1 node scripts/compile.js
node scripts/stock-world-source-verify.js
```

The read-only RPC scan discovers Worlds from this Factory and submits their seven modules. Rerun to poll accepted jobs or retry failed requests. It also verifies the shared contracts. The build must match the public V8 manifest in `config/stock-world.mainnet-v8.json`; stale artifacts or changed sources are rejected. No private deployment report, signer, private key, transaction, or Gas is required. Checkpoints are saved in the ignored local reports directory.

## New Worlds

The website requests verification when it opens a World, including the redirect after successful creation. The server derives canonical addresses from the pinned mainnet Factory, not from user-supplied addresses. It submits the exact public compiler input to Sourcify and caches accepted jobs. The page polls for completion with a bounded retry loop. Reopening a World retries interrupted or unavailable verification.

Direct contract callers must open their World on the website or run the CLI to trigger this workflow. This is not a chain-wide background indexer. Verification submissions continue on Sourcify after acceptance even if the page closes. Availability and completion time depend on Sourcify; a failed verification service never blocks launch, Mint, or trading.

The page displays a source link only after both creation and runtime match exactly. An accepted job is shown as pending, not verified. Source links reset when switching Worlds.

Canonical World discovery uses the official public RPC, with a fixed PublicNode read-only fallback if the former is unavailable or rate-limited. Every successful discovery checks chain ID 4663 before decoding the Factory result. Both are public services; their availability is not guaranteed.

## Explorer Badges

Sourcify verification and Blockscout's local Verified badge are separate. On the verification date, external propagation encountered an Etherscan daily submission limit and a Blockscout HTTP 403 challenge. Consequently, this document does not claim all Blockscout badges have appeared. The website provides direct Sourcify source links independently of that propagation.

FIRST's token was also submitted through Blockscout's native Standard JSON form. Its explorer page was subsequently confirmed to display **Contract source code verified (exact match)**, with Solidity 0.8.35, Shanghai, optimizer enabled, and 1 optimizer run. This native explorer result is confirmed for FIRST's token only; the other 18 contracts have the independently confirmed Sourcify matches described above.

## Website Build

Generate the public verification input before bundling the website Worker:

```sh
node scripts/stock-world-source-verify.js ../cloudflare-worker-source/stock-world-verification-input.json
```

Only Solidity files under `src/`, compiler settings, public addresses, and the read-only Factory ABI enter this bundle. Never bundle deployment reports, environment files, wallet material, or credentials. The input is bound to this immutable Factory/build; a new deployment needs a matching bundle and explicit frontend allowlist update.
