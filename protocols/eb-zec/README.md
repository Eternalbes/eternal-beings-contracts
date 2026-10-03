# EB-ZEC V0 Local Reference

Version 0.1.0. Experimental, local-only reference implementation of the published [memo protocol](../../docs/zcash/EB-ZEC-Memo-Inscription-Protocol-v1.md). This package does not change the Ethereum or Robinhood deployments.

**This is not a running Zcash network integration, mainnet release, native NFT, native token, bridge, or marketplace.** The input is an explicitly labeled local chain fixture containing already-decrypted memo records. No Zcash node, Orchard scanner, wallet RPC, spending key, or transaction broadcaster is included. Fake mailbox/viewing-key placeholders cannot be used to send ZEC. Network 0/1 manifests are rejected.

## Run

From this directory, with Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm test
npm run demo
npm run replay -- output/fixture.json output/replayed-snapshot.json
npm run serve
```

`demo` produces a deterministic public fixture, state snapshot, six real SVG previews, metadata, and a static gallery at `output/index.html`. Open that HTML file directly; it needs no web server. It Mints three Beings, completes a Hunt, fuses one authorized sacrifice, devours another, and rejects a forged nonce. The last survivor has two consumed sacrifices; `minted_total` remains three. Replaying from genesis must reproduce the snapshot byte for byte.

The optional read-only API listens on `127.0.0.1:8787`. Use `PORT=8788 npm run serve` if the port is occupied. It loads a fixed fixture at startup; it is not a live chain listener. Stop with Ctrl+C.

`output/`, `local/`, environment files, and secret JSON files are ignored. No private key files are written by the demo. Its deterministic **public test control keys** are deliberately reproducible and must never control a real world or hold funds. Reveal secrets appear in public memos by design; unrevealed production secrets would require encrypted client-only storage, not this fixture builder.

## Implemented

- The exact 512-byte `0xFF + JCS JSON + zero padding` carrier, strict UTF-8, schema validation, canonical binary encodings, and Ed25519 signatures.
- BLAKE2b-256 with output length 32, not a truncated BLAKE2b-512 hash. Fixed domain separation and little-endian numeric encodings.
- Signed genesis matching a pinned immutable manifest, renderer source hash, and rule implementation hash.
- Commit / future-block ticket selection / reveal. Rankings are fixed at the beacon, including rounds in which nobody reveals.
- Lifetime Mint accounting separate from active supply. Consuming a Being never restores a genesis Mint slot.
- Hunt lock, minimum duration, diminishing endurance, bounded rewards, global per-block resource budget and hard resource ceiling.
- Single-use, recipient-specific, mode-specific, expiring consume permits. Changing the sacrifice head invalidates its prior permit. Only same-world Beings can be consumed.
- Fusion transforms lineage weights and morphology instead of inheriting every large donor attribute. `A+B` and `AB+A` yield different states and SVGs.
- Future-beacon evolution settlement, busy-state locking, persistent rare glyph rows and border traits.
- Confirmations, canonical transaction/output ordering, rejection journal, deterministic rebuild, reorganization rollback, and Being-state Merkle checkpoints.
- Deterministic static SVG and JSON metadata with six lineages, simple initial forms, bounded advanced wings/heads, no external assets/scripts, and compressed hybrid forms.
- Public signing material, signed memo construction, signature/envelope validation and bounded local HTTP APIs. Private keys stay in the local signer, never in API requests.

The codec structurally validates all fourteen published operations. The state machine applies the nine V0 operations only. `transfer`, `list`, `cancel`, `buy`, and `payment-ack` deliberately return `UNSUPPORTED_V0_OPERATION`; V0.5 authorization and settlement are not implemented.

## Reference Profile Clarifications

These choices fill gaps in the implementable draft. They are bound to this local release; they are **not an unnoticed amendment to a published live world**.

| Topic | Local reference rule |
| --- | --- |
| Activation | Protocol major 0, minor 1, network 2, local mailbox placeholders, maximum 333 lifetime Mints |
| Confirmation depth | 1 in the fast fixture; not a production recommendation |
| Round numbering | Starts at 0; first Commit height is genesis + 1 |
| Round boundaries | Inclusive Commit/reveal ranges; reveal starts at beacon + 1; no separate Claim operation |
| Beacon | Commit end + delay; canonical 32-byte hash in display hex byte order, not reversed |
| Ordering | Heights and transaction indexes from the supplied canonical block record; output indexes sorted numerically |
| Unrevealed slots | Become available next round; no within-round promotion of losers |
| Evolution | Accepted mutate/devour/fuse schedules settlement at event height + 2; randomness includes that future block hash |
| Pending evolution | Parent is busy until the beacon is application-confirmed; sacrifices are consumed immediately on a valid fusion/devour |
| Settlement | Genome/traits/growth update deterministically; history records the beacon; last user event and nonce remain anchored to the accepted action |
| Persistent traits | First glyph award adds one row; maximum 32 rows; a border never disappears; static output only, no animation in this release |
| Fusion growth | +2 Mass and +2 Complexity; lineage blend is 3 parent : 1 donor; donor Power/Skill/resources are not copied |
| Devour growth | +1 Mass and +1 Complexity; does not inherit donor lineage |
| Mutation | 100 basis points for added lineage influence; separate rare glyph/border rolls; retries require a new confirmed transaction after settlement |
| Glyph chance | Devour 5 bp, fusion 50 bp, mutate 20 bp per eligible event |
| Border chance | Devour 1 bp, fusion 10 bp, mutate 5 bp per eligible event |
| Resources | Application-only resources, 8 decimals; ceiling 21,000,000 whole resources (2,100,000,000,000,000 smallest units); global unlock 1,000 smallest units per block |
| Numeric limits | Unsigned exact JSON integers; attributes bounded to uint32; overflow rejects before sacrificing anything |
| Merkle tree | Byte-sorted Being IDs; domain-separated leaves and internal nodes; odd node duplicated; empty root has its own domain |

The renderer identifies one symbol in each initial form. These are founding glyphs, not a rare awarded text row. Rare additional text rows are separately stored in `glyph_rows`.

`fixtures/golden-v0.1.json` contains the public signed memos, local block journal, expected state root, accepted/rejected events and image hashes for this exact release. `npm test` checks it without regenerating it. Maintainers can explicitly run `npm run vectors` after a reviewed implementation/version change; doing so is not a substitute for an independent implementation's conformance test.

Future beacons prevent precomputing a final evolution solely by grinding a transaction ID. They are **not VRF-grade randomness**: miners can influence beacons, Sybil controllers can buy more attempts, and a malicious fixture provider can invent a chain. No economic fairness or live-chain authenticity claim follows from local test success.

## API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/network` | Fixture source, observed/finalized height, state root and explicit capability flags |
| GET | `/v1/worlds/{world_id}` | Immutable manifest and lifetime/live/consumed supply |
| GET | `/v1/beings` | Being states plus SVG/metadata URLs |
| GET | `/v1/beings/{being_id}` | Application-confirmed state |
| GET | `/v1/beings/{being_id}/render.svg` | Canonical static SVG |
| GET | `/v1/beings/{being_id}/metadata.json` | Canonical metadata with embedded SVG |
| GET | `/v1/beings/{being_id}/history` | Accepted action and evolution-beacon history |
| GET | `/v1/mint/rounds/current` | Current observed round and finalized ranking |
| GET | `/v1/mint/rounds/{round_id}` | Round bounds, commitments, tickets and selection |
| GET | `/v1/events/{txid}/{output_index}` | Accepted/rejected/provisional event status; no unrelated raw memo |
| GET | `/v1/checkpoints/{height}` | Checkpoints every 100 finalized blocks, including genesis |
| GET | `/v1/renderers/{renderer_id}` | Renderer version/source identifier |
| POST | `/v1/prepare/message` | `{ "message": UNSIGNED_OBJECT }` returns canonical JSON and digest; not authorization |
| POST | `/v1/validate/memo` | `{ "memo_hex": "..." }` checks envelope/schema/signature; not state authorization |
| POST | `/v1/render/verify` | `{ "being_id": "...", "svg_hash": "..." }` compares the canonical image hash |

There is no raw transaction submission, key recovery, attribute editing, signing server or fund custody endpoint. Host and Origin are restricted to localhost, body size is limited to 16 KiB, and the API has no CORS wildcard. Do not expose it publicly as a production service.

## Input Boundary and Persistence

Fixtures explicitly set `source_kind: "local-fixture"`. Their `blocks` contain hashes, parent hashes, ordered transactions and decoded output records: `index`, `recipient`, `value_zat`, `memo_hex`. The mailbox must match the manifest. Multiple candidate protocol carriers in one transaction fail closed. This conservative local policy is not yet a chain-wide scanner proving there were no EB-ZEC operations in other mailboxes.

The reference retains the supplied block journal and rebuilds state from its canonical prefix. A parent mismatch is rejected; callers must use `replaceFrom(commonAncestor + 1, replacementBlocks)` to perform explicit rollback/replay. Rebuilding the demo from the saved fixture restores the same state. This is bounded to 10,000 blocks, 256 transactions/block and 8 outputs/transaction and is not a production database/scanner.

## Required Before a Live Release

1. A real Zebra/Zaino/lightwalletd and librustzcash scanner that verifies canonical blocks, decrypts the mailbox, and supplies complete transaction context; run it first on actual Zcash regtest/testnet.
2. A wallet adapter, real UA/UIVK, tested carrier/fee policy, secure controller backups and a separate explicitly reviewed genesis manifest. Do not reuse the demo control keys.
3. An independent second implementation, preferably Rust/WASM, passing the same public vectors, state roots and SVG hashes. A second Node process is a reproducibility check, not an independent implementation.
4. Production persistence, incremental rollback, bounded retention/rate limits, monitoring and independent indexers. Revisit all probability, resource and difficulty values before freezing any live world.
5. V0.5 transfer and independently verified same-transaction payment settlement. Cooperative shielded settlement must retain its counterparty-risk warning.

No Ethereum NFT lock proof, cross-chain ownership or 3D client is included. The earlier generated 3D images remain design concepts; the previews here are real deterministic output of this code.

## Dependencies

Hashes use [noble-hashes](https://github.com/paulmillr/noble-hashes), canonical serialization uses [canonicalize](https://github.com/erdtman/canonicalize), schema validation uses [Ajv 2020-12](https://ajv.js.org/json-schema.html), and Ed25519 uses Node's standard crypto library. Exact dependency versions and integrity hashes are pinned in the package lock. No cryptographic primitive is hand-rolled.
