# EB-ZEC Memo Inscription Protocol

## Version 1.0

Status: implementable draft

Protocol identifier: `eb-zec`

Website: https://eternalbeings.space

## 1 Purpose

EB-ZEC defines Eternal Beings as a deterministic application protocol carried by encrypted Zcash memos. Zcash confirms and orders the carrier transactions. Independent EB-ZEC indexers decrypt messages sent to the protocol mailbox, validate the same rules, and derive the same Being state.

An EB-ZEC message is not a native Zcash asset and does not execute inside a Zcash smart contract. Protocol ownership is controlled by an independent Ed25519 key. The Zcash account pays transaction fees but is not the Being controller.

## 2 Wire Format

Each operation is one JSON object carried by one shielded output to the `protocol_ua` in the active WorldManifest.

```text
memo[0]       = 0xFF
memo[1..N]    = UTF8(JCS(message))
memo[N+1..511]= 0x00 padding
```

Rules:

- The memo is exactly 512 bytes.
- The JSON payload must fit within the 511 bytes after `0xFF`.
- The JSON is minified and canonicalized with RFC 8785 JSON Canonicalization Scheme before signing and encoding.
- Duplicate keys, unknown required fields, floating point values, invalid UTF-8, noncanonical JSON, and nonzero padding are invalid.
- Binary values use unpadded base64url. A 32 byte value is 43 characters; a 16 byte value is 22 characters; a 64 byte signature is 86 characters.
- Integers are unsigned decimal JSON integers, must remain inside the field bounds, and may not exceed `9007199254740991` (`2^53-1`). This keeps RFC 8785 number serialization identical across common implementations.
- Exactly one EB-ZEC operation is allowed per Zcash transaction.
- An operation is accepted only after the confirmation depth in the WorldManifest.

The examples below are displayed with readable key order and spacing. Production clients must serialize them as minified JCS before signing and placing them in the memo.

## 3 Common Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `p` | string | Always `eb-zec` |
| `op` | string | Operation name |
| `v` | uint | Protocol major version, currently `1` |
| `world` | b64url16 | Immutable world identifier |
| `being` | b64url32 | Being identifier; omitted from MINT commit and reveal |
| `prev` | b64url32 | Previous accepted event for this Being |
| `nonce` | uint64 bounded to 2^53-1 | Exactly the current Being nonce plus one |
| `controller` | b64url32 | Ed25519 public key authorizing the operation |
| `sig` | b64url64 | Ed25519 signature over the unsigned canonical message |

The signature is calculated after removing `sig`:

```text
unsigned = message with the sig member removed
digest = BLAKE2b-256("EBZ_SIGN_V1" || UTF8(JCS(unsigned)))
sig = Ed25519.Sign(controller_secret_key, digest)
```

`world-genesis` verifies `sig` against its `release` key. MINT verifies against the committed `controller`. Post-MINT commands use the role stated in the operation registry.

The event identifier is:

```text
event_id = BLAKE2b-256(
  "EBZ_EVENT_V1" || txid || uint32_le(output_index) ||
  BLAKE2b-256(UTF8(JCS(message)))
)
```

## 4 Operation Registry

| `op` | Release | Authorizer | Purpose |
| --- | --- | --- | --- |
| `world-genesis` | V0 | release key | Commits the immutable WorldManifest |
| `mint-commit` | V0 | new controller | Enters one MINT round |
| `mint-reveal` | V0 | committed controller | Reveals a selected commitment |
| `transfer` | V0.5 | current controller | Changes the Being controller |
| `hunt-start` | V0 | current controller | Locks a Being into a scene |
| `hunt-resolve` | V0 | current controller | Resolves an eligible hunt |
| `mutate` | V0 | current controller | Attempts a deterministic mutation |
| `consume-permit` | V0 | sacrifice controller | Authorizes one Being to consume another |
| `devour` | V0 | primary controller | Consumes an authorized object |
| `fuse` | V0 | primary controller | Fuses an authorized Being into the primary Being |
| `list` | V0.5 | current controller | Creates or replaces a sale listing |
| `cancel` | V0.5 | current controller | Cancels an active listing |
| `buy` | V0.5 | buyer controller | Pays and transfers a public listing |
| `payment-ack` | V0.5 | seller controller | Acknowledges cooperative shielded payment |

Using the fixed binary lengths and a 35 character transparent receiver, the minified reference messages range from 299 to 452 JSON bytes. The largest current operation therefore leaves 59 bytes inside the 511 byte JSON budget. Implementations must still measure the final canonical UTF-8 payload before transaction construction.

## 5 World Genesis

```json
{
  "p": "eb-zec",
  "op": "world-genesis",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "manifest": "MANIFEST_HASH_B64URL",
  "height": 3100000,
  "release": "RELEASE_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

The WorldManifest contains the network, protocol mailbox UA and UIVK, confirmation depth, MINT schedule, maximum supply, ruleset hash, renderer hash, activation height, and release key. The first accepted genesis for a `world` is final.

## 6 MINT

### 6.1 Create a Commitment

The client creates a new controller key, 32 byte `secret`, 32 byte `salt`, and 16 byte `client` value.

```text
commitment = BLAKE2b-256(
  "EBZ_MINT_COMMIT_V1" || world || uint64_le(round) ||
  controller || secret || salt || client
)
```

### 6.2 MINT Commit Message

```json
{
  "p": "eb-zec",
  "op": "mint-commit",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "round": 42,
  "controller": "NEW_CONTROLLER_PUBLIC_KEY_B64URL",
  "commitment": "COMMITMENT_B64URL",
  "client": "RANDOM_16_BYTES_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

One transaction may contain only one `mint-commit`. A controller, commitment, and client value may enter a round only once. The client must retain the controller secret key, `secret`, `salt`, round, and commit event ID.

### 6.3 Selection

```text
beacon_height = commit_close_height + beacon_delay_blocks
beacon = block_hash(beacon_height)
ticket = BLAKE2b-256(
  "EBZ_MINT_TICKET_V1" || world || uint64_le(round) ||
  beacon || commit_event_id
)
```

Valid commitments are ranked by ascending ticket and then ascending event ID. The first `mint_slots_per_round` entries are selected, limited by remaining unminted supply.

### 6.4 MINT Reveal Message

```json
{
  "p": "eb-zec",
  "op": "mint-reveal",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "round": 42,
  "commit": "COMMIT_EVENT_ID_B64URL",
  "secret": "SECRET_B64URL",
  "salt": "SALT_B64URL",
  "controller": "NEW_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

Only a selected commitment may reveal, once, inside the reveal window. The indexer recomputes the commitment before creating the Being.

```text
being_id = BLAKE2b-256("EBZ_BEING_ID_V1" || world || commit_event_id)
genome = BLAKE2b-256("EBZ_GENOME_V1" || world || being_id || secret || beacon)
```

## 7 Transfer

```json
{
  "p": "eb-zec",
  "op": "transfer",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "PREVIOUS_EVENT_ID_B64URL",
  "nonce": 9,
  "to": "RECIPIENT_CONTROLLER_PUBLIC_KEY_B64URL",
  "controller": "CURRENT_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

`to` is a fresh Being controller public key, not a Zcash payment address and not a viewing key hash. This separation keeps funding addresses independent from public protocol ownership and gives the recipient a key that can authorize later actions. After acceptance, the old controller cannot act.

## 8 Hunt and Evolution

### 8.1 Start Hunt

```json
{
  "p": "eb-zec",
  "op": "hunt-start",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "PREVIOUS_EVENT_ID_B64URL",
  "nonce": 10,
  "scene": 3,
  "controller": "CURRENT_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

The scene must exist in the fixed ruleset. Acceptance locks the Being at the event block height. It cannot transfer, hunt again, mutate, devour, fuse, or list while occupied.

### 8.2 Resolve Hunt

```json
{
  "p": "eb-zec",
  "op": "hunt-resolve",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "HUNT_START_EVENT_ID_B64URL",
  "nonce": 11,
  "controller": "CURRENT_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

The indexer rejects resolution before the scene minimum block duration. Rewards and changes to Power, Skill, genome, and resources are deterministic from the prior state, start event, resolve event, elapsed blocks, scene, and fixed ruleset.

### 8.3 Mutate

```json
{
  "p": "eb-zec",
  "op": "mutate",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "PREVIOUS_EVENT_ID_B64URL",
  "nonce": 12,
  "controller": "CURRENT_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

The sender cannot choose the mutation result. The ruleset derives success, lineage influence, morphology, color, glyph, border, and animation traits from the accepted event and previous state.

## 9 Safe Consumption and Fusion

### 9.1 Consume Permit

The sacrifice must authorize one specific consumer before it can be consumed.

```json
{
  "p": "eb-zec",
  "op": "consume-permit",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "SACRIFICE_BEING_ID_B64URL",
  "prev": "SACRIFICE_PREVIOUS_EVENT_ID_B64URL",
  "nonce": 4,
  "consumer": "PRIMARY_BEING_ID_B64URL",
  "mode": "fuse",
  "expires": 3115000,
  "controller": "SACRIFICE_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

`mode` is `devour` or `fuse`. A permit is single use, expires at the declared height, and becomes invalid if the sacrifice changes state first.

### 9.2 Devour

```json
{
  "p": "eb-zec",
  "op": "devour",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "PRIMARY_BEING_ID_B64URL",
  "prev": "PRIMARY_PREVIOUS_EVENT_ID_B64URL",
  "nonce": 21,
  "sacrifice": "SACRIFICE_ID_B64URL",
  "permit": "CONSUME_PERMIT_EVENT_ID_B64URL",
  "controller": "PRIMARY_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

### 9.3 Fuse

```json
{
  "p": "eb-zec",
  "op": "fuse",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "PRIMARY_BEING_ID_B64URL",
  "prev": "PRIMARY_PREVIOUS_EVENT_ID_B64URL",
  "nonce": 22,
  "sacrifice": "SACRIFICE_BEING_ID_B64URL",
  "permit": "CONSUME_PERMIT_EVENT_ID_B64URL",
  "controller": "PRIMARY_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

On acceptance, the sacrifice becomes permanently consumed and cannot transfer or act again. The primary Being receives a deterministic state transition. Fusion emphasizes lineage and morphology transformation; it does not merely add arbitrary line count or inflate every stat.

External Ethereum NFTs are not valid V1 sacrifices unless a later bridge specification supplies a final Ethereum lock proof. An indexer cannot infer Ethereum destruction from a Zcash memo alone.

## 10 Listing and Trading

### 10.1 List

```json
{
  "p": "eb-zec",
  "op": "list",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "PREVIOUS_EVENT_ID_B64URL",
  "nonce": 30,
  "price_zat": 25000000,
  "pay_to": "SELLER_TRANSPARENT_ZCASH_ADDRESS",
  "expires": 3120000,
  "controller": "SELLER_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

A later valid list replaces the earlier listing. Any accepted gameplay or transfer event invalidates the listing. The listing ID is its event ID.

### 10.2 Cancel

```json
{
  "p": "eb-zec",
  "op": "cancel",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "LIST_EVENT_ID_B64URL",
  "nonce": 31,
  "listing": "LIST_EVENT_ID_B64URL",
  "controller": "SELLER_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

### 10.3 Publicly Verifiable Buy

```json
{
  "p": "eb-zec",
  "op": "buy",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "listing": "LIST_EVENT_ID_B64URL",
  "amount_zat": 25000000,
  "controller": "BUYER_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

The same Zcash transaction must contain:

1. A transparent output paying at least `price_zat` to the exact `pay_to` address in the listing.
2. A shielded output to `protocol_ua` carrying the signed `buy` memo.

The first valid buy by canonical chain position wins. On acceptance, the controller becomes the buyer controller. Public settlement reveals the payment amount and seller receiver but not necessarily the buyer funding address.

### 10.4 Shielded Cooperative Payment Acknowledgement

```json
{
  "p": "eb-zec",
  "op": "payment-ack",
  "v": 1,
  "world": "WORLD_ID_B64URL",
  "being": "BEING_ID_B64URL",
  "prev": "LIST_EVENT_ID_B64URL",
  "nonce": 31,
  "listing": "LIST_EVENT_ID_B64URL",
  "buy": "BUY_EVENT_ID_B64URL",
  "controller": "SELLER_CONTROLLER_PUBLIC_KEY_B64URL",
  "sig": "SIGNATURE_B64URL"
}
```

This mode is cooperative, not trustless atomic settlement. A public indexer cannot independently prove a shielded receipt without suitable payment disclosure or viewing capability.

## 11 Common Validation

For every post-MINT operation, an indexer checks:

1. `p`, `v`, `world`, and `op` are recognized and active.
2. The carrier transaction and output are canonical and sufficiently confirmed.
3. The Being exists, is active, and is not consumed.
4. `prev` equals the Being's current last event when the operation requires it.
5. `nonce` equals the Being's current nonce plus one when the operation requires it.
6. `controller` is the authorized key for the referenced role.
7. `sig` verifies over the canonical unsigned message.
8. The operation is legal in the current state and block range.
9. Every identifier, integer, string, and enum is within the fixed schema.
10. No referenced permit, listing, commitment, or payment has already been consumed.

Conflicting valid messages are ordered by block height, transaction index, and shielded output index. A chain reorganization rolls back derived state to the common finalized ancestor and replays canonical events.

## 12 Sending a Message

The protocol command is the JSON object. A wallet adapter performs four mechanical steps:

1. Build the unsigned object.
2. JCS canonicalize, hash, and sign it with the controller key.
3. Add `sig`, canonicalize again, prepend `0xFF`, and zero pad to 512 bytes.
4. Send that memo in a shielded output to the WorldManifest `protocol_ua`.

Equivalent low level RPC shape:

```bash
zcash-cli z_sendmany \
  "<FROM_UNIFIED_ADDRESS>" \
  '[{"address":"<PROTOCOL_UA>","amount":<CARRIER_ZEC>,"memo":"<1024_HEX_CHARS>"}]' \
  10 null "FullPrivacy"
```

The 1024 hexadecimal characters encode all 512 memo bytes. The wallet must calculate the active ZIP 317 fee rather than hard coding a permanent fee.

## 13 Required Test Vectors

The release package must include valid and invalid vectors for every operation. At minimum it must test duplicate keys, wrong protocol, wrong world, wrong controller, altered signature, stale `prev`, skipped `nonce`, replay, oversized JSON, noncanonical JSON, early hunt resolution, expired permit, reused sacrifice, unauthorized fusion, listing race, underpayment, buy versus cancel, confirmation rollback, and database rebuild from genesis.

Two independent implementations must produce identical event ordering, Being state, state roots, and rendered SVG hashes before mainnet activation.
