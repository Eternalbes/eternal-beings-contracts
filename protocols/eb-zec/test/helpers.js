const crypto = require("node:crypto");
const { hash, b64, signMessage, commitment, eventId, publicKeyBytes } = require("../lib/crypto");
const { encodeMemo } = require("../lib/memo");
const { manifestHash } = require("../lib/profile");
const { rulesetId } = require("../lib/rules");
const { rendererId } = require("../lib/renderer");
const { Indexer } = require("../lib/indexer");

// Public deterministic TEST control keys. Never use these for a real world.
function fixtureKey(index) {
  const seed = hash("EBZ_PUBLIC_LOCAL_TEST_KEY", String(index));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), seed,
  ]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, controller: b64(publicKeyBytes(publicKey)) };
}

function makeManifest(overrides = {}) {
  return { protocol: "ebz", protocol_major: 0, protocol_minor: 1, network: 2,
    world_id: b64(hash("EBZ_LOCAL_DEMO_WORLD").subarray(0,16)), genesis_height: 0,
    protocol_ua: "local:eb-zec-mailbox", protocol_uivk: "local:no-real-viewing-key",
    carrier_value_zat: 0, confirmation_depth: 1, commit_blocks: 3, beacon_delay_blocks: 1,
    reveal_blocks: 4, mint_slots_per_round: 3, max_supply: 333,
    renderer_id: rendererId(), ruleset_id: rulesetId(), release_key: fixtureKey(0).controller,
    ...overrides };
}

function makeTransaction(manifest, unsigned, key, tag) {
  const message = signMessage(unsigned, key.privateKey);
  const txid = hash("EBZ_LOCAL_TX", tag, encodeMemo(message)).toString("hex");
  return { txid, outputs: [{ index: 0, recipient: manifest.protocol_ua, value_zat: manifest.carrier_value_zat,
    memo_hex: encodeMemo(message).toString("hex") }] };
}

function block(previous, transactions = [], tag = "main") {
  const height = previous ? previous.height + 1 : 0;
  const parent = previous ? previous.hash : "0".repeat(64);
  return { height, parent_hash: parent,
    hash: hash("EBZ_LOCAL_BLOCK", parent, String(height), tag, JSON.stringify(transactions)).toString("hex"), transactions };
}

function base(manifest, op, fields) { return { p: "eb-zec", v: 1, world: manifest.world_id, op, ...fields }; }
function start(overrides = {}) {
  const manifest = makeManifest(overrides);
  const indexer = new Indexer(manifest);
  const genesis = makeTransaction(manifest, base(manifest, "world-genesis", {
    manifest: manifestHash(manifest), height: manifest.genesis_height, release: manifest.release_key,
  }), fixtureKey(0), "genesis");
  const first = block(null, [genesis]);
  indexer.append([first]);
  return { manifest, indexer, blocks: [first] };
}

function append(context, txs = [], tag) {
  const next = block(context.blocks.at(-1), txs, tag);
  context.indexer.append([next]);
  context.blocks.push(next);
  return next;
}

function prepareCommit(manifest, key, round = 0, tag = String(round)) {
  const secret = b64(hash("EBZ_TEST_SECRET", key.controller, tag));
  const salt = b64(hash("EBZ_TEST_SALT", key.controller, tag));
  const client = b64(hash("EBZ_TEST_CLIENT", key.controller, tag).subarray(0,16));
  const commit = makeTransaction(manifest, base(manifest, "mint-commit", { round, controller: key.controller,
    commitment: commitment(manifest.world_id, round, key.controller, secret, salt, client), client }), key, `commit-${tag}`);
  const id = eventId(commit.txid, 0, require("../lib/memo").decodeMemo(commit.outputs[0].memo_hex));
  const reveal = makeTransaction(manifest, base(manifest, "mint-reveal", { round, controller: key.controller,
    commit: id, secret, salt }), key, `reveal-${tag}`);
  return { key, secret, salt, client, commit, commitId: id, reveal };
}

function minted(count = 3, overrides = {}) {
  const context = start(overrides);
  const entries = Array.from({ length: count }, (_, i) => prepareCommit(context.manifest, fixtureKey(i+1), 0, String(i)));
  append(context, entries.map((entry) => entry.commit));
  append(context); append(context); append(context);
  append(context, entries.map((entry) => entry.reveal));
  return { ...context, entries };
}

function command(context, being, op, key, fields = {}, tag = op) {
  return makeTransaction(context.manifest, base(context.manifest, op, { being: being.being_id,
    prev: being.last_event, nonce: being.nonce + 1, controller: key.controller, ...fields }), key, tag);
}

module.exports = { fixtureKey, makeManifest, makeTransaction, block, base, start, append, prepareCommit, minted, command };
