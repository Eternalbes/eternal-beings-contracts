# Read-Only Zcashd Regtest Observation Adapter

This adapter is the next integration boundary after the V0 local reference. It queries a **locally operated zcashd-compatible regtest node/wallet** over JSON-RPC. It does not mine, create addresses, import/export keys, sign, send transactions, or apply observations to the reference Indexer. It is not a mainnet or testnet release.

The adapter was tested against an HTTP RPC mock using the documented response shapes. **No real zcashd, Zebra, Zallet, Orchard decryption or regtest transaction integration test has been completed by this package.** Compatibility with an actual node/version must be confirmed before relying on its captures.

## Prerequisites

An operator must separately provide a running regtest node, an existing Unified Address with an Orchard receiver known to its wallet, and a wallet scan covering the whole relevant history. Do not use a wallet containing production funds. Provisioning the node, activating NU5, generating blocks, sending carriers, creating controller keys and importing a viewing key are outside this read-only tool. It never asks for a spending key or mnemonic.

The declared RPC compatibility target is the [Zcash 6.12.2 RPC documentation](https://zcash.github.io/rpc/). This is a bounded integration prototype, not a recommendation to run an old or deprecated wallet in production. [zcashd has reached end of life](https://github.com/zcash/zcash); new live setup should follow the [Zebra/Zallet integration plan](regtest/README.md), not install this old compatibility target. A future Zebra/Zaino/librustzcash scanner can replace this boundary without changing the published V0.1 fixture rules.

## Run

From this package directory, set these variables in your local environment:

| Variable | Meaning |
| --- | --- |
| `EBZ_RPC_URL` | Numeric loopback URL; default `http://127.0.0.1:18232/`; root path only |
| `EBZ_RPC_USER`, `EBZ_RPC_PASSWORD` | Optional local RPC Basic authentication; both or neither; never put them in a URL or commit them |
| `EBZ_REGTEST_MAILBOX` | Existing Unified Address owned/watched by the local regtest wallet; fake `local:` placeholders are rejected |
| `EBZ_REGTEST_GENESIS_HASH` | Explicit operator-pinned regtest chain hash at height 0, in RPC display hex byte order |
| `EBZ_REGTEST_FROM_HEIGHT` | Required inclusive scan start; no implicit full-wallet scan |
| `EBZ_REGTEST_CONFIRMATIONS` | 1..100; default 2; regtest setting only |
| `EBZ_REGTEST_MAX_BLOCKS` | 1..200 per capture; default 100 |

```sh
npm run scan:regtest -- regtest-observation-001.json
```

The filename is a basename, not a path. A successful capture is saved exclusively under ignored `output/` with file mode 0600; an existing file is never overwritten. Do not upload captures: they contain decrypted protocol memos, mailbox identifiers and note values. Authentication and endpoint details are omitted from captures and sanitized out of errors. The tool does not automatically load `.env` files.

## Checks and Limits

- Only numeric IPv4/IPv6 loopback endpoints are allowed. No redirects, remote hostnames, URL credentials, arbitrary methods or TLS verification bypass.
- The transport allows seven read-only methods: `getblockchaininfo`, `getblockhash`, `getblock`, `getrawtransaction`, `z_listunifiedreceivers`, `z_listreceivedbyaddress`, and `rpc.discover`. The legacy scanner uses the first six; discovery is used by the separate modern preflight only. Existing scanner calls stay in JSON-RPC 1.0 mode, while the preflight explicitly uses 2.0.
- Abort immediately unless the node reports `regtest`; check the pinned chain hash and the canonical tip before and after reading. A new tip is acceptable only when the original anchor remains canonical. A detected reorg produces no capture; rerun from the reviewed common ancestor. There is no automatic cursor database or rollback service yet.
- Scan only application-confirmed heights. Preserve every transaction ID and its original position, including unrelated transactions. Verify parent links, note height/transaction index and transaction inclusion.
- Read wallet **received history**, not the unspent-note set, so spending a carrier does not silently erase its memo. Query as of the bounded scan end and reject unconfirmed/out-of-snapshot records.
- Protocol candidates must be in the Orchard pool, have exactly 512 memo bytes and an integer `amountZat`. Never reconstruct money by floating-point multiplication of `amount` in ZEC. Check each action index against `getrawtransaction`'s Orchard action count in the containing active block.
- Keep malformed `0xFF` protocol envelopes for diagnosis, but do not include unrelated memo contents. Multiple protocol candidates in a transaction are preserved, not combined into one operation. State/batch authorization is deliberately not performed here.
- Bound RPC response bytes (32 MiB), each response deadline (10 seconds), note history (20,000), protocol candidates (1,024), block transactions (12,000), and total batch transactions (100,000). Oversized histories fail closed; no silent truncation.

## Trust Boundary

`source_kind` is `zcashd-regtest-rpc`, not `local-fixture`. The format is `eb-zec-regtest-observation-v1`. The existing fixture loader rejects it, preventing an accidental unreviewed live-profile activation. Real block parents and transaction positions must not be replaced with synthetic local genesis/order data to bypass that restriction.

The wallet/node reports decrypted memos and values; this JavaScript adapter does **not** independently trial-decrypt Orchard ciphertext or validate Zcash consensus. Checking transaction/action inclusion is not a cryptographic proof of the reported memo or amount. A malicious/incompletely rescanned wallet can omit notes, and this adapter cannot prove completeness or see protocol carriers sent to other mailboxes. An observation hash checks capture consistency, not authenticity. Envelope signature validity does not authorize a state transition, Mint or payout.

Before applying real-chain events, implement and test independent viewing-key scanning, complete mailbox context, durable reorg-aware persistence, a reviewed chain-specific signed genesis/profile and a real wallet broadcaster with explicit spending approval. Network 0/1 and V0.5 transfer/trading remain unavailable. No new contract deployment is performed by this adapter.

## Primary Interface References

- [Received-note history](https://zcash.github.io/rpc/z_listreceivedbyaddress.html): historical-height query, integer zatoshis, pool and output/action location.
- [Block records](https://zcash.github.io/rpc/getblock.html) and [chain status](https://zcash.github.io/rpc/getblockchaininfo.html): canonical heights, hashes and transaction order.
- [Raw transaction details](https://zcash.github.io/rpc/getrawtransaction.html): containing-block lookup and Orchard action array.
- [Unified receivers](https://zcash.github.io/rpc/z_listunifiedreceivers.html): Orchard receiver availability.
