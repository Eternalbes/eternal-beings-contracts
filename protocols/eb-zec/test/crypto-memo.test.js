const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { hash, b64, bytes, uintLE, canonical, signMessage, verifyMessage, eventId, keyPair } = require("../lib/crypto");
const { encodeMemo, decodeMemo } = require("../lib/memo");
const { signingMaterial, signedCarrier, carrierFromSigned } = require("../lib/client");
const { fixtureKey, makeManifest, base } = require("./helpers");

function signed() {
  const manifest = makeManifest(), key = fixtureKey(1);
  return signMessage(base(manifest, "mint-commit", { round: 0, controller: key.controller,
    commitment: b64(hash("commit")), client: b64(hash("client").subarray(0,16)) }), key.privateKey);
}

function raw(text) {
  const memo = Buffer.alloc(512); memo[0] = 0xff;
  Buffer.from(text).copy(memo, 1); return memo;
}

test("BLAKE2b-256 known answer and unsigned little-endian serialization", () => {
  assert.equal(hash("").toString("hex"), "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
  assert.notEqual(hash("").toString("hex"), crypto.createHash("blake2b512").update("").digest().subarray(0,32).toString("hex"));
  assert.equal(uintLE(258).toString("hex"), "0201000000000000");
  assert.equal(uintLE(258,4).toString("hex"), "02010000");
  assert.throws(() => uintLE(2**32,4), /INTEGER_OVERFLOW/);
});

test("real Ed25519 signing and strict canonical base64url", () => {
  const key = keyPair();
  assert.throws(() => signMessage({ ...signed(), sig: undefined },key.privateKey), /ALREADY_SIGNED/);
  const { sig, ...unsigned } = signed();
  const message = signMessage({ ...unsigned, controller: key.controller }, key.privateKey);
  verifyMessage(message);
});

test("signature tampering is rejected; event identity includes transaction and output", () => {
  const message = signed();
  verifyMessage(message);
  assert.throws(() => verifyMessage({ ...message, round: 1 }), /INVALID_SIGNATURE/);
  assert.throws(() => bytes(b64(Buffer.alloc(32)) + "=",32), /INVALID_BASE64URL/);
  const alias = b64(Buffer.alloc(32)).slice(0,-1) + "B";
  assert.throws(() => bytes(alias,32), /INVALID_BASE64URL/);
  assert.notEqual(eventId("1".repeat(64),0,message), eventId("1".repeat(64),1,message));
  assert.notEqual(eventId("1".repeat(64),0,message), eventId("2".repeat(64),0,message));
});

test("valid memo is canonical, exactly 512 bytes, and round trips", () => {
  const message = signed(), memo = encodeMemo(message);
  assert.equal(memo.length,512);
  assert.equal(memo[0],255);
  assert.deepEqual(decodeMemo(memo), message);
  assert.deepEqual(decodeMemo(memo.toString("hex")), message);
  assert.equal(encodeMemo(decodeMemo(memo)).toString("hex"), memo.toString("hex"));
});

test("malformed envelope, padding, UTF-8, JSON and signature do not pass", () => {
  const message = signed();
  assert.throws(() => decodeMemo(Buffer.alloc(512)), /INVALID_MEMO_ENVELOPE/);
  assert.throws(() => decodeMemo(Buffer.alloc(511)), /INVALID_MEMO_ENVELOPE/);
  assert.throws(() => decodeMemo("00"), /INVALID_MEMO_HEX/);
  const padded = encodeMemo(message); padded[511]=1;
  assert.throws(() => decodeMemo(padded), /NONZERO_PADDING/);
  const utf = raw("{}"); utf[1]=0xc0; utf[2]=0xaf;
  assert.throws(() => decodeMemo(utf), /INVALID_UTF8/);
  assert.throws(() => decodeMemo(raw("{")), /INVALID_JSON/);
  assert.throws(() => decodeMemo(raw(" " + canonical(message))), /NONCANONICAL_JSON/);
  const duplicate = canonical(message).replace('"op":"mint-commit"', '"op":"mutate","op":"mint-commit"');
  assert.throws(() => decodeMemo(raw(duplicate)), /NONCANONICAL_JSON/);
  assert.throws(() => decodeMemo(raw(canonical(message).replace('"round":0','"round":0.0'))), /NONCANONICAL_JSON/);
  assert.throws(() => decodeMemo(raw(canonical(message).replace('"round":0','"round":-0'))), /NONCANONICAL_JSON/);
  assert.throws(() => decodeMemo(raw(canonical({ ...message, sig: b64(Buffer.alloc(64)) }))), /INVALID_SIGNATURE/);
});

test("unknown fields and out-of-range integers are rejected even when correctly signed", () => {
  const { sig, ...unsigned } = signed(), key = fixtureKey(1);
  for (const patch of [{ power: 9999 }, { privateKey: "not-a-key" }, { round: -1 }, { round: 0.5 },
    { round: Number.MAX_SAFE_INTEGER+1 }, { p: "other" }, { v: 2 }]) {
    assert.throws(() => encodeMemo(signMessage({ ...unsigned, ...patch },key.privateKey)), /INVALID_SCHEMA/);
  }
});

test("all protocol operation examples fit in the memo budget", () => {
  const m = makeManifest(), key = fixtureKey(1), id = b64(hash("id"));
  const head = { being: id, prev: id, nonce: 1, controller: key.controller };
  const operations = {
    "world-genesis": { manifest: id, height: 0, release: key.controller },
    "mint-commit": { round: 0, controller: key.controller, commitment: id, client: m.world_id },
    "mint-reveal": { round: 0, controller: key.controller, commit: id, secret: id, salt: id },
    transfer: { ...head, to: id }, "hunt-start": { ...head, scene: 0 }, "hunt-resolve": head,
    mutate: head, "consume-permit": { ...head, consumer: id, mode: "fuse", expires: 100 },
    devour: { ...head, sacrifice: id, permit: id }, fuse: { ...head, sacrifice: id, permit: id },
    list: { ...head, price_zat: 100, pay_to: "t1" + "a".repeat(33), expires: 100 },
    cancel: { ...head, listing: id }, buy: { being: id, listing: id, amount_zat: 100, controller: key.controller },
    "payment-ack": { ...head, listing: id, buy: id },
  };
  for (const [op, fields] of Object.entries(operations)) {
    const message = signMessage(base(m,op,fields),key.privateKey);
    assert.ok(Buffer.byteLength(canonical(message))<=511,op);
    assert.deepEqual(decodeMemo(encodeMemo(message)),message);
  }
});

test("client prepares a public digest and signs only locally, without a broadcaster", () => {
  const m = makeManifest(), key = fixtureKey(1), { sig, ...unsigned } = signed();
  const material = signingMaterial(unsigned);
  assert.equal(material.needs_local_signature,true);
  assert.equal(material.signing_digest_hex.length,64);
  const carrier = signedCarrier(m,unsigned,key.privateKey);
  assert.equal(carrier.memo_hex.length,1024);
  assert.equal(carrierFromSigned(m,carrier.message).broadcast_supported,false);
  assert.throws(() => signingMaterial({ ...unsigned, privateKey: "secret" }), /INVALID_SCHEMA/);
});
