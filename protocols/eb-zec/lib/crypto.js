const crypto = require("node:crypto");
const canonicalize = require("canonicalize");
const { blake2b } = require("@noble/hashes/blake2b");

class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function ensure(condition, code) {
  if (!condition) throw new ProtocolError(code);
}

function hash(...parts) {
  return Buffer.from(blake2b(Buffer.concat(parts.map((part) => Buffer.from(part))), { dkLen: 32 }));
}

function b64(value) { return Buffer.from(value).toString("base64url"); }
function bytes(value, length) {
  ensure(typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value), "INVALID_BASE64URL");
  const decoded = Buffer.from(value, "base64url");
  ensure(decoded.length === length && b64(decoded) === value, "INVALID_BASE64URL");
  return decoded;
}

function uintLE(value, length = 8) {
  ensure(Number.isSafeInteger(value) && value >= 0, "INVALID_INTEGER");
  const result = Buffer.alloc(length);
  if (length === 4) {
    ensure(value <= 0xffffffff, "INTEGER_OVERFLOW");
    result.writeUInt32LE(value);
  } else result.writeBigUInt64LE(BigInt(value));
  return result;
}

function canonical(value) {
  const encoded = canonicalize(value);
  ensure(typeof encoded === "string", "INVALID_JSON");
  return encoded;
}

function signingDigest(message) {
  const { sig, ...unsigned } = message;
  return hash("EBZ_SIGN_V1", canonical(unsigned));
}

function publicKeyBytes(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).subarray(-32);
}

function keyPair() {
  const keys = crypto.generateKeyPairSync("ed25519");
  return { ...keys, controller: b64(publicKeyBytes(keys.publicKey)) };
}

function signMessage(unsigned, privateKey) {
  ensure(!Object.hasOwn(unsigned, "sig"), "ALREADY_SIGNED");
  return { ...unsigned, sig: b64(crypto.sign(null, signingDigest(unsigned), privateKey)) };
}

function verifyMessage(message) {
  const raw = bytes(message.op === "world-genesis" ? message.release : message.controller, 32);
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der", type: "spki",
  });
  ensure(crypto.verify(null, signingDigest(message), key, bytes(message.sig, 64)), "INVALID_SIGNATURE");
}

function commitment(world, round, controller, secret, salt, client) {
  return b64(hash("EBZ_MINT_COMMIT_V1", bytes(world, 16), uintLE(round), bytes(controller, 32),
    bytes(secret, 32), bytes(salt, 32), bytes(client, 16)));
}

function eventId(txid, outputIndex, message) {
  ensure(typeof txid === "string" && /^[0-9a-f]{64}$/.test(txid), "INVALID_TXID");
  return b64(hash("EBZ_EVENT_V1", Buffer.from(txid, "hex"), uintLE(outputIndex, 4), hash(canonical(message))));
}

function add(a, b, maximum = Number.MAX_SAFE_INTEGER) {
  ensure(Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= 0 && a <= maximum - b,
    "INTEGER_OVERFLOW");
  return a + b;
}

module.exports = { ProtocolError, ensure, hash, b64, bytes, uintLE, canonical, signingDigest,
  publicKeyBytes, keyPair, signMessage, verifyMessage, commitment, eventId, add };
