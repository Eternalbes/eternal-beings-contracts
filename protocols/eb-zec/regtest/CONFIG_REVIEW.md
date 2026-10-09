# Offline Regtest Configuration Review

This is a pre-start policy checker for an **isolated, operator-reviewed Z3 regtest environment**. It reads Docker Compose's resolved JSON model, not raw YAML. It does not invoke Docker, initialize a wallet, create volumes, pull images, mine blocks, read spending keys or send transactions. It is not a launch authorization or a live Zcash integration test.

The official [`docker compose config` interface](https://docs.docker.com/reference/cli/docker/compose/config/) merges files, resolves variables and expands shorthand into the model that would be applied to the Docker Engine. Use `--format json` from the separately reviewed regtest project. **Do not run the upstream default invocation**, which selects mainnet. The current machine has no Docker runtime; this checker and its tests operate without it.

## Private Inputs

Resolved configuration can contain passwords and wallet paths. Keep it in the package's ignored `local/` directory, with file mode `0600` and an owner-controlled directory. Never commit it or paste it into a public issue. The checker accepts only a regular, singly linked, private-permission file up to 1 MiB; it rejects final-path symlinks, invalid UTF-8 and malformed JSON. Errors do not echo input contents.

Set these non-secret policy values to the actual reviewed project:

| Variable | Requirement |
| --- | --- |
| `EBZ_REGTEST_PROJECT` | A fresh dedicated name matching `ebz-regtest-...`; not an existing production/regtest project |
| `EBZ_REGTEST_CONFIG_ROOT` | Absolute owner-controlled directory holding reviewed regtest-only TOML files |

From `protocols/eb-zec`, after independently obtaining a resolved model:

```sh
npm run review:regtest-config -- local/regtest.compose.resolved.json
```

Exit 0 means the static checks passed, 2 means policy blockers were found, and 1 means invalid input or tool failure. The output contains counts and fixed diagnostic codes, not environment values, mount paths, image references, raw commands or credentials.

## Enforced Static Policy

- Exact dedicated project name; Zebra, Zallet and the RPC router are required. Only those services, the reviewed permission helper and optional Zaino are recognized.
- Image references pinned by SHA-256 digest. Mutable tags and on-the-fly `build` definitions are not accepted. Build and inspect a reviewed router separately before supplying its immutable image reference; this tool does not do that for you.
- Published ports must be individual TCP ports bound explicitly to `127.0.0.1` or `::1`, with no duplicate host binding. Omitted addresses, public interfaces, hostname aliases, UDP and port ranges fail closed.
- Named volumes and networks must use the dedicated project namespace, with no external resources, arbitrary drivers or driver options. Data mounts are restricted to the reviewed stack's known targets, with volume copy-up disabled. Runtime volume freshness is **not** inferred from a matching name.
- Host binds are restricted to read-only TOML files lexically inside the specified config directory, at the expected node configuration target. Auto-creation of host paths, Docker sockets, host wallet paths and duplicate mount targets are rejected.
- Drop all Linux capabilities and require `no-new-privileges`. Only the small entrypoint/permission capability sets recorded in the reviewed upstream stack are allowed. Unknown service/top-level fields, privileged mode, host namespaces, devices, external networks, unreviewed helpers and security-policy overrides fail closed.
- Zebra and optional Zaino must have explicit `Regtest` environment values. Unresolved environment placeholders are rejected. This does **not** verify Zallet's TOML network/upgrade settings or prove that a container will honor its environment.

The checker is intentionally stricter than upstream defaults. It is not a generic Compose schema validator and may reject otherwise valid Compose features until explicitly reviewed. Its test fixtures contain fake `example.invalid` images and dummy digests; they are structural tests, **not a runnable node stack or real image lock**.

## Remaining Manual Checks

Even when `static_checks_passed` is true, `config_files_verified`, `image_contents_verified`, `volume_freshness_verified`, `runtime_started`, `wallet_initialized`, `chain_actions_enabled` and `real_memo_integration_test_complete` remain false.

Before starting anything, an operator still needs to:

1. Verify filesystem ownership, symlinks and actual TOML contents, including regtest network selection and matching upgrade schedules. Lexical path checks cannot prove those facts.
2. Verify immutable image provenance, native architecture compatibility, entrypoints, commands, healthchecks and effective network endpoints. A digest alone is not an image trust decision. This checker does not inspect container code or arbitrary scripts.
3. Confirm that the dedicated named volumes do not already hold another wallet. Never reset or delete an existing wallet/volume merely to get a clean test.
4. Review the exact resolved configuration one final time, then explicitly approve runtime startup and wallet initialization. A future launcher must revalidate the same model rather than changing it after review.
5. Run the read-only node doctor against a separately pinned regtest chain, establish wallet scan readiness, and perform real 512-byte memo round-trip tests before enabling a new live profile.

This tool never executes upstream `regtest-init.sh` and does not solve the remaining runtime, independent decryption, live manifest or transaction broadcaster requirements.
