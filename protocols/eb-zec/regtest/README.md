# Modern Regtest Integration Plan

The preferred next live integration is **Zebra + Zallet + the Z3 RPC router**, not a new production zcashd deployment. [zcashd's upstream repository](https://github.com/zcash/zcash) is archived and documents its end of support. The older observation adapter remains a frozen local compatibility prototype; its RPC shape target is not a recommendation to install an old node.

This directory records a reviewed [official Z3 source revision](https://github.com/ZcashFoundation/z3/tree/e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb). It does **not** vendor the stack, pin container image digests, start containers, provision wallets or implement live Mint. The repository under `local/` or an external audit checkout must never be added to this public protocol package: runtime configurations, volumes and captures may contain private material.

## Read-Only Doctor

```sh
npm run doctor:regtest
```

Without RPC settings, this only checks local Docker CLI/Compose versions. It does not install software, pull images, inspect wallet files or contact a node. It does not check or start the Docker daemon. Exit 2 means prerequisites are missing, not that any chain operation failed.

To additionally probe an already reviewed local regtest router, provide `EBZ_RPC_URL` and `EBZ_REGTEST_GENESIS_HASH` in the environment. Optional `EBZ_RPC_USER` / `EBZ_RPC_PASSWORD` stay private in the transport. The probe sends JSON-RPC 2.0 `getblockchaininfo`, `getblockhash` and `rpc.discover` only. It validates a consistent pinned chain anchor and reports required method declarations. It never reads memos, sends funds, executes methods listed in discovery, follows discovered server URLs or changes the method allowlist.

An OpenRPC declaration does not prove its method is implemented, correctly routed or compatible with our scanner. Missing/duplicate required methods block this preflight. A reported initial-sync failure also blocks it; an absent sync field is reported as unknown, not healthy. Explicit `/ready`/wallet scanning checks still need live integration. `prerequisites_present: true` is not spending approval and does not enable Mint, Hunt, Fusion or trading.

We require the RPC chain label to be exactly `regtest`. Some upstream examples show `test` even for a regtest setup. This probe deliberately rejects that ambiguity instead of accepting public testnet by a label alias or guessed genesis pin. A verified source-level network discriminator is required before supporting such a node build.

## Operator Setup Boundary

An [offline resolved-Compose checker](CONFIG_REVIEW.md) is available through `npm run review:regtest-config -- local/regtest.compose.resolved.json`. It checks dedicated project/volume/network scope, pinned image references, explicit loopback port bindings and reviewed mount/hardening policies without invoking Docker. Input configuration stays private, and diagnostics omit its environment values. A passing static report does not verify TOML contents, image provenance, wallet volume freshness or permit runtime startup.

The [official Z3 regtest guide](https://github.com/ZcashFoundation/z3/blob/e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb/docs/regtest.md) requires Docker Compose 2.24.4+. It provides a per-network regtest stack and RPC router. Zebra and Zallet need matching upgrade schedules, including Orchard activation. Use a **new, isolated regtest project** with no production wallets, no real ZEC and no externally published RPC ports. Review resolved Compose bindings, image digests and the local activation schedule before starting it; a pinned source commit does not pin mutable image tags.

Do not blindly run upstream `scripts/regtest-init.sh`: the reviewed script can stop/remove existing regtest containers, modify wallet volumes and initialize mnemonic/encryption material. We have not executed it. A project-specific wrapper must first scope its project/volumes, ensure loopback-only RPC bindings and obtain explicit approval for wallet initialization. Existing wallet data must not be reset for convenience.

After runtime setup, the actual acceptance sequence remains:

1. Verify the regtest network, matching upgrade schedule, chain anchor and wallet scan readiness.
2. Create a fresh regtest mailbox and private controller keys, keeping backups out of GitHub.
3. Send a signed 512-byte carrier from a funded **regtest-only** wallet and independently verify memo/amount decoding and transaction/action positions.
4. Verify confirmation delay, block extension, reorg rollback, spent-carrier history and malformed/multiple-carrier rejection.
5. Review and sign a separate real-chain genesis/profile before connecting observations to the state machine. Never rewrite real records into the V0.1 synthetic fixture format.
6. Run real commit/reveal, Hunt and Fusion end-to-end. Only then consider V0.5 transfer and atomic payment verification.

Current status: transport/preflight, offline configuration policy checks and mock tests are implemented. The local fixture also has a bounded [durable SQLite journal](../PERSISTENCE.md). A real runtime, live carrier test, independent decryption, real-chain durable indexing, wallet broadcaster, V0.5 and mainnet activation are **not complete**. The V0.1 golden vectors and signed rule identifiers remain unchanged.
