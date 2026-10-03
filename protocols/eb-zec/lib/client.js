const { ensure, canonical, signingDigest, signMessage } = require("./crypto");
const { encodeMemo, validateMessage } = require("./memo");

function signedCarrier(manifest, unsigned, privateKey) {
  ensure(unsigned.world === manifest.world_id, "WRONG_WORLD");
  const message = signMessage(unsigned, privateKey);
  const memo = encodeMemo(message);
  return { message, recipient: manifest.protocol_ua, value_zat: manifest.carrier_value_zat,
    memo_hex: memo.toString("hex") };
}

function signingMaterial(unsigned) {
  ensure(unsigned && !Object.hasOwn(unsigned, "sig"), "UNSIGNED_MESSAGE_REQUIRED");
  // Structural validation uses a placeholder signature but never marks the
  // unsigned message as authorized. Real verification remains local/client-side.
  const placeholder = { ...unsigned, sig: Buffer.alloc(64).toString("base64url") };
  const { checkStructure } = require("./memo");
  checkStructure(placeholder);
  const predictedLength = Buffer.byteLength(canonical(placeholder));
  ensure(predictedLength <= 511, "MEMO_TOO_LARGE");
  return { unsigned_json: canonical(unsigned), signing_digest_hex: signingDigest(unsigned).toString("hex"),
    predicted_signed_json_bytes: predictedLength, needs_local_signature: true };
}

function carrierFromSigned(manifest, message) {
  validateMessage(message);
  ensure(message.world === manifest.world_id, "WRONG_WORLD");
  return { recipient: manifest.protocol_ua, value_zat: manifest.carrier_value_zat,
    memo_hex: encodeMemo(message).toString("hex"), broadcast_supported: false };
}

module.exports = { signedCarrier, signingMaterial, carrierFromSigned };
