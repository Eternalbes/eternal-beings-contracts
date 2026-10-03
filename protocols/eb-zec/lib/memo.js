const Ajv2020 = require("ajv/dist/2020");
const schema = require("../../../docs/zcash/eb-zec-v1.schema.json");
const { ensure, canonical, bytes, verifyMessage } = require("./crypto");

const validate = new Ajv2020({ strict: false, allErrors: false }).compile(schema);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function checkStructure(message) {
  ensure(validate(message), "INVALID_SCHEMA");
  for (const field of ["world", "client"]) if (message[field]) bytes(message[field], 16);
  for (const field of ["being", "prev", "controller", "manifest", "release", "commitment", "commit",
    "secret", "salt", "to", "consumer", "sacrifice", "permit", "listing", "buy"]) {
    if (message[field]) bytes(message[field], 32);
  }
  bytes(message.sig, 64);
  return message;
}

function validateMessage(message) {
  checkStructure(message);
  verifyMessage(message);
  return message;
}

function encodeMemo(message) {
  validateMessage(message);
  const payload = Buffer.from(canonical(message));
  ensure(payload.length <= 511, "MEMO_TOO_LARGE");
  const memo = Buffer.alloc(512);
  memo[0] = 0xff;
  payload.copy(memo, 1);
  return memo;
}

function decodeMemo(input) {
  let memo;
  if (typeof input === "string") {
    ensure(/^[0-9a-f]{1024}$/.test(input), "INVALID_MEMO_HEX");
    memo = Buffer.from(input, "hex");
  } else {
    ensure(input instanceof Uint8Array, "INVALID_MEMO_TYPE");
    memo = Buffer.from(input);
  }
  ensure(memo.length === 512 && memo[0] === 0xff, "INVALID_MEMO_ENVELOPE");
  const firstZero = memo.indexOf(0, 1);
  const end = firstZero === -1 ? 512 : firstZero;
  ensure(memo.subarray(end).every((byte) => byte === 0), "NONZERO_PADDING");
  let text;
  try { text = decoder.decode(memo.subarray(1, end)); }
  catch { ensure(false, "INVALID_UTF8"); }
  let message;
  try { message = JSON.parse(text); }
  catch { ensure(false, "INVALID_JSON"); }
  // Comparing the original wire bytes to JCS also rejects duplicate keys,
  // alternate numeric spellings, escaped aliases, and whitespace.
  ensure(canonical(message) === text, "NONCANONICAL_JSON");
  return validateMessage(message);
}

module.exports = { encodeMemo, decodeMemo, validateMessage, checkStructure };
