const { ensure, canonical, hash, b64 } = require("../lib/crypto");
const { decodeMemo } = require("../lib/memo");

const HEX32 = /^[0-9a-f]{64}$/;
const MEMO = /^[0-9a-fA-F]{1024}$/;
const integer = (value, maximum = 0xffffffff) => Number.isInteger(value) && value >= 0 && value <= maximum;

function chainInfo(info) {
  ensure(info && info.chain === "regtest", "REGTEST_RPC_ONLY");
  ensure(integer(info.blocks) && typeof info.bestblockhash === "string" && HEX32.test(info.bestblockhash), "INVALID_NODE_TIP");
  return { height: info.blocks, hash: info.bestblockhash };
}

// A read-only observation boundary, deliberately NOT an Indexer input/profile.
async function scanRegtest(rpc, { mailbox, genesisHash, fromHeight, confirmationDepth = 2, maxBlocks = 100 }) {
  ensure(typeof mailbox === "string" && /^[A-Za-z0-9]{1,512}$/.test(mailbox), "INVALID_MAILBOX");
  ensure(typeof genesisHash === "string" && HEX32.test(genesisHash), "GENESIS_PIN_REQUIRED");
  ensure(integer(fromHeight) && integer(confirmationDepth, 100) && confirmationDepth > 0 &&
    integer(maxBlocks, 200) && maxBlocks > 0, "INVALID_SCAN_RANGE");
  const tip = chainInfo(await rpc.call("getblockchaininfo"));
  ensure(await rpc.call("getblockhash", [0]) === genesisHash, "NODE_GENESIS_MISMATCH");
  ensure(await rpc.call("getblockhash", [tip.height]) === tip.hash, "SCAN_REORG_DETECTED");
  const receivers = await rpc.call("z_listunifiedreceivers", [mailbox]);
  ensure(receivers && typeof receivers.orchard === "string" &&
    /^[A-Za-z0-9]{1,512}$/.test(receivers.orchard), "ORCHARD_MAILBOX_REQUIRED");
  const confirmedHeight = tip.height - confirmationDepth + 1;
  const toHeight = Math.min(confirmedHeight, fromHeight + maxBlocks - 1);
  const blocks = [], transactions = new Map(), blockHashes = new Set();
  let parent = fromHeight && fromHeight <= toHeight ? await rpc.call("getblockhash", [fromHeight - 1]) : "0".repeat(64);
  ensure(HEX32.test(parent), "INVALID_NODE_BLOCK_HASH");
  for (let h = fromHeight; h <= toHeight; h++) {
    const blockHash = await rpc.call("getblockhash", [h]);
    ensure(typeof blockHash === "string" && HEX32.test(blockHash), "INVALID_NODE_BLOCK_HASH");
    ensure(!blockHashes.has(blockHash), "DUPLICATE_NODE_BLOCK"); blockHashes.add(blockHash);
    const block = await rpc.call("getblock", [blockHash, 1]);
    ensure(block && block.hash === blockHash && block.height === h && integer(block.confirmations) &&
      block.confirmations >= confirmationDepth && (block.previousblockhash || (h === 0 && "0".repeat(64))) === parent,
    "NODE_BLOCK_MISMATCH");
    ensure(Array.isArray(block.tx) && block.tx.length <= 12000 &&
      block.tx.every((txid) => typeof txid === "string" && HEX32.test(txid)), "INVALID_NODE_TRANSACTIONS");
    ensure(transactions.size + block.tx.length <= 100000, "SCAN_TRANSACTION_LIMIT");
    block.tx.forEach((txid, transactionIndex) => {
      ensure(!transactions.has(txid), "DUPLICATE_NODE_TRANSACTION");
      transactions.set(txid, { height: h, transaction_index: transactionIndex, block_hash: blockHash });
    });
    blocks.push({ height: h, hash: blockHash, parent_hash: parent, transaction_ids: block.tx.slice() });
    parent = blockHash;
  }

  const candidates = [], ignored = { non_protocol: 0, outside_range: 0 };
  if (blocks.length) {
    // All received notes, including spent ones. z_listunspent would erase protocol history.
    const notes = await rpc.call("z_listreceivedbyaddress", [mailbox, 1, toHeight]);
    ensure(Array.isArray(notes) && notes.length <= 20000, "SCAN_NOTE_LIMIT");
    const seenNotes = new Set(), rawTransactions = new Map();
    for (const note of notes) {
      ensure(note && integer(note.blockheight) && integer(note.confirmations) && note.confirmations >= 1,
        "UNCONFIRMED_OR_INVALID_NOTE");
      ensure(note.blockheight <= toHeight, "NOTE_AFTER_SNAPSHOT");
      if (note.blockheight < fromHeight) { ignored.outside_range++; continue; }
      if (note.pool === "transparent") { ignored.non_protocol++; continue; }
      ensure(typeof note.memo === "string" && MEMO.test(note.memo), "INVALID_NOTE_MEMO");
      if (!note.memo.toLowerCase().startsWith("ff")) { ignored.non_protocol++; continue; }
      ensure(candidates.length < 1024, "SCAN_CANDIDATE_LIMIT");
      ensure(note.pool === "orchard", "UNSUPPORTED_CARRIER_POOL");
      ensure(typeof note.txid === "string" && HEX32.test(note.txid) && integer(note.outindex), "INVALID_NOTE_LOCATION");
      const location = transactions.get(note.txid);
      ensure(location && note.blockheight === location.height && note.blockindex === location.transaction_index,
        "NOTE_TRANSACTION_MISMATCH");
      ensure(Number.isSafeInteger(note.amountZat) && note.amountZat >= 0 && note.amountZat <= 2100000000000000,
        "INTEGER_ZAT_REQUIRED");
      const noteId = `${note.txid}/orchard/${note.outindex}`;
      ensure(!seenNotes.has(noteId), "DUPLICATE_NODE_NOTE"); seenNotes.add(noteId);
      if (!rawTransactions.has(note.txid)) {
        const raw = await rpc.call("getrawtransaction", [note.txid, 1, location.block_hash]);
        ensure(raw && raw.txid === note.txid && raw.blockhash === location.block_hash && raw.in_active_chain === true &&
          Array.isArray(raw.orchard?.actions) && raw.orchard.actions.length <= 12000,
        "NODE_TRANSACTION_MISMATCH");
        rawTransactions.set(note.txid, raw);
      }
      ensure(note.outindex < rawTransactions.get(note.txid).orchard.actions.length, "INVALID_ORCHARD_ACTION_INDEX");
      const memoHex = note.memo.toLowerCase();
      const candidate = { ...location, txid: note.txid, pool: "orchard", output_index: note.outindex,
        recipient: mailbox, value_zat: note.amountZat, memo_hex: memoHex,
        envelope_valid: false, state_authorized: false };
      try {
        const message = decodeMemo(memoHex);
        candidate.envelope_valid = true;
        candidate.op = message.op;
        candidate.world_id = message.world;
      } catch (error) { candidate.error_code = error.code || "INVALID_MESSAGE"; }
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a.height - b.height || a.transaction_index - b.transaction_index || a.output_index - b.output_index);
  // A growing tip is fine only if the original tip remains canonical. No partial result on a reorg.
  const current = chainInfo(await rpc.call("getblockchaininfo"));
  ensure(current.height >= tip.height && await rpc.call("getblockhash", [current.height]) === current.hash &&
    await rpc.call("getblockhash", [tip.height]) === tip.hash &&
    await rpc.call("getblockhash", [0]) === genesisHash, "SCAN_REORG_DETECTED");
  if (blocks.length) ensure(await rpc.call("getblockhash", [toHeight]) === blocks.at(-1).hash, "SCAN_REORG_DETECTED");
  const observation = {
    format: "eb-zec-regtest-observation-v1", source_kind: "zcashd-regtest-rpc", network: "regtest",
    trust: "local-node-wallet-reported-decryption", independently_decrypted: false,
    protocol_state_applied: false, broadcast_supported: false, genesis_hash: genesisHash, mailbox,
    anchor_tip: tip, confirmation_depth: confirmationDepth,
    range: blocks.length ? { from_height: fromHeight, to_height: toHeight } : null,
    next_height: blocks.length ? toHeight + 1 : fromHeight, blocks, candidates, ignored,
  };
  return { ...observation, observation_hash: b64(hash("EBZ_REGTEST_OBSERVATION_V1", canonical(observation))) };
}

module.exports = { scanRegtest };
