const { ensure, b64, bytes, hash, canonical, uintLE, eventId, commitment, add } = require("./crypto");
const { decodeMemo } = require("./memo");
const { validateManifest, manifestHash, roundWindow } = require("./profile");
const { RULESET, initialTraits, evolve, huntReward } = require("./rules");

const OPERATIONS = new Set(["world-genesis", "mint-commit", "mint-reveal", "hunt-start", "hunt-resolve",
  "mutate", "consume-permit", "devour", "fuse"]);
const HEX32 = /^[0-9a-f]{64}$/;
const clone = (value) => structuredClone(value);

function emptyState(world) {
  return { world_id: world, genesis_event: null, minted_total: 0, live_supply: 0, consumed_total: 0,
    issued_resource_units: 0, beings: {}, commits: {}, rounds: {}, permits: {}, journal: {}, histories: {} };
}

function stateRoot(being) { return hash("EBZ_STATE_V1", canonical(being)); }
function checkpointRoot(beings) {
  const ordered = Object.values(beings).sort((a, b) => Buffer.compare(bytes(a.being_id, 32), bytes(b.being_id, 32)));
  let nodes = ordered.map((being) => hash("EBZ_LEAF_LOCAL_V01", bytes(being.being_id, 32), stateRoot(being)));
  if (!nodes.length) return b64(hash("EBZ_EMPTY_LOCAL_V01"));
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) next.push(hash("EBZ_NODE_LOCAL_V01", nodes[i], nodes[i+1] || nodes[i]));
    nodes = next;
  }
  return b64(nodes[0]);
}

class Indexer {
  constructor(manifest) {
    this.manifest = validateManifest(manifest);
    this.chain = [];
    this.state = emptyState(manifest.world_id);
    this.finalizedHeight = manifest.genesis_height - 1;
    this.observedHeight = manifest.genesis_height - 1;
    this.checkpoints = {};
  }

  append(blocks) { return this.replaceFrom(this.manifest.genesis_height + this.chain.length, blocks); }

  replaceFrom(height, blocks) {
    ensure(Number.isSafeInteger(height) && height >= this.manifest.genesis_height &&
      height <= this.manifest.genesis_height + this.chain.length && Array.isArray(blocks), "INVALID_REORG_RANGE");
    const chain = this.chain.slice(0, height - this.manifest.genesis_height).concat(clone(blocks));
    this._validateChain(chain);
    const replay = this._replay(chain);
    this.chain = chain;
    this.state = replay.state;
    this.finalizedHeight = replay.finalizedHeight;
    this.observedHeight = chain.length ? chain.at(-1).height : this.manifest.genesis_height - 1;
    this.checkpoints = replay.checkpoints;
    return this.snapshot();
  }

  _validateChain(chain) {
    ensure(chain.length <= 10000, "LOCAL_BLOCK_LIMIT");
    const seenTx = new Set(), seenHash = new Set();
    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];
      ensure(block && block.height === this.manifest.genesis_height + i && block.height <= 0xffffffff &&
        HEX32.test(block.hash) && HEX32.test(block.parent_hash), "INVALID_BLOCK");
      ensure(!seenHash.has(block.hash), "DUPLICATE_BLOCK_HASH"); seenHash.add(block.hash);
      if (i) ensure(block.parent_hash === chain[i-1].hash, "PARENT_HASH_MISMATCH");
      else ensure(block.parent_hash === "0".repeat(64), "LOCAL_GENESIS_PARENT_MISMATCH");
      ensure(Array.isArray(block.transactions) && block.transactions.length <= 256, "INVALID_TRANSACTIONS");
      for (const tx of block.transactions) {
        ensure(tx && HEX32.test(tx.txid) && !seenTx.has(tx.txid), "DUPLICATE_OR_INVALID_TXID");
        seenTx.add(tx.txid);
        ensure(Array.isArray(tx.outputs) && tx.outputs.length <= 8, "INVALID_OUTPUTS");
        const outputIndexes = new Set();
        for (const output of tx.outputs) {
          ensure(Number.isInteger(output.index) && output.index >= 0 && output.index <= 0xffffffff &&
            !outputIndexes.has(output.index), "INVALID_OUTPUT_INDEX");
          outputIndexes.add(output.index);
          ensure(typeof output.recipient === "string" && output.recipient.length <= 512 &&
            Number.isSafeInteger(output.value_zat) && output.value_zat >= 0 &&
            typeof output.memo_hex === "string" && output.memo_hex.length <= 1024, "INVALID_CARRIER_RECORD");
        }
      }
    }
  }

  _replay(chain) {
    let state = emptyState(this.manifest.world_id);
    const finalizedHeight = chain.length ? Math.max(this.manifest.genesis_height - 1,
      chain.at(-1).height - this.manifest.confirmation_depth + 1) :
      this.manifest.genesis_height - 1;
    const checkpoints = {};
    const hashes = new Map(chain.filter((block) => block.height <= finalizedHeight).map((block) => [block.height, block.hash]));
    for (const block of chain) {
      if (block.height > finalizedHeight) break;
      for (let transactionIndex = 0; transactionIndex < block.transactions.length; transactionIndex++) {
        const tx = block.transactions[transactionIndex];
        const carriers = tx.outputs.filter((output) => output.recipient === this.manifest.protocol_ua &&
          output.memo_hex.startsWith("ff")).sort((a, b) => a.index - b.index);
        for (const output of carriers) {
          const location = `${tx.txid}/${output.index}`;
          const record = { txid: tx.txid, output_index: output.index, height: block.height,
            transaction_index: transactionIndex, memo_hash: b64(hash(Buffer.from(output.memo_hex, "hex"))),
            status: "rejected", stage: "envelope" };
          try {
            ensure(carriers.length === 1, "BATCH_OPERATION_FORBIDDEN");
            ensure(output.value_zat >= this.manifest.carrier_value_zat, "INSUFFICIENT_CARRIER");
            const message = decodeMemo(output.memo_hex);
            record.stage = "state";
            record.op = message.op;
            const id = eventId(tx.txid, output.index, message);
            record.event_id = id;
            const candidate = clone(state);
            this._apply(candidate, message, id, block.height, hashes);
            state = candidate;
            record.status = "accepted";
          } catch (error) {
            record.error_code = error.code || "INVALID_MESSAGE";
          }
          state.journal[location] = record;
        }
      }
      // Fix tickets and capacity at the beacon, even if nobody ever reveals.
      // Later mints or consumed Beings must not change historical rankings.
      for (const roundId of Object.keys(state.rounds)) {
        if (roundWindow(this.manifest, Number(roundId)).beacon_height === block.height) {
          this._select(state, Number(roundId), hashes);
        }
      }
      for (const being of Object.values(state.beings)) {
        const pending = being.pending_evolution;
        if (pending && pending.beacon_height === block.height) {
          evolve(being, pending.event_id, pending.mode, pending.donor, block.hash);
          being.pending_evolution = null;
          being.history_root = b64(hash("EBZ_EVOLUTION_BEACON_LOCAL_V01", bytes(being.history_root, 32),
            bytes(pending.event_id, 32), Buffer.from(block.hash, "hex")));
          state.histories[being.being_id].push({ event_id: pending.event_id, op: "evolution-settled",
            height: block.height, beacon_hash: block.hash });
        }
      }
      if ((block.height - this.manifest.genesis_height) % 100 === 0) {
        checkpoints[block.height] = { height: block.height, block_hash: block.hash,
          root: checkpointRoot(state.beings), minted_total: state.minted_total, live_supply: state.live_supply };
      }
    }
    return { state, finalizedHeight, checkpoints };
  }

  _apply(state, message, id, height, hashes) {
    const m = this.manifest;
    ensure(message.world === m.world_id, "WRONG_WORLD");
    ensure(OPERATIONS.has(message.op), "UNSUPPORTED_V0_OPERATION");
    if (message.op === "world-genesis") {
      ensure(!state.genesis_event, "GENESIS_ALREADY_EXISTS");
      ensure(height === m.genesis_height && message.height === height && message.release === m.release_key &&
        message.manifest === manifestHash(m), "GENESIS_MISMATCH");
      state.genesis_event = id;
      return;
    }
    ensure(state.genesis_event, "GENESIS_REQUIRED");
    if (message.op === "mint-commit") {
      const window = roundWindow(m, message.round);
      ensure(height >= window.start && height <= window.commit_end, "WRONG_COMMIT_PHASE");
      ensure(state.minted_total < m.max_supply, "MINT_CAP_REACHED");
      for (const entry of Object.values(state.commits)) {
        ensure(!(entry.round === message.round && entry.controller === message.controller), "DUPLICATE_CONTROLLER");
        ensure(entry.commitment !== message.commitment && entry.client !== message.client, "DUPLICATE_COMMITMENT");
      }
      state.commits[id] = { ...message, event_id: id, revealed: false };
      const round = state.rounds[message.round] ||= { commits: [], selected: null, beacon: null, tickets: [] };
      round.commits.push(id);
      return;
    }
    if (message.op === "mint-reveal") {
      const window = roundWindow(m, message.round);
      ensure(height >= window.reveal_start && height <= window.reveal_end, "WRONG_REVEAL_PHASE");
      const entry = state.commits[message.commit];
      ensure(entry && entry.round === message.round && entry.controller === message.controller && !entry.revealed,
        "INVALID_OR_USED_COMMITMENT");
      ensure(entry.commitment === commitment(m.world_id, message.round, message.controller,
        message.secret, message.salt, entry.client), "COMMITMENT_MISMATCH");
      const round = state.rounds[message.round];
      this._select(state, message.round, hashes);
      ensure(round.selected.includes(message.commit), "NOT_SELECTED");
      ensure(state.minted_total < m.max_supply, "MINT_CAP_REACHED");
      const beingId = b64(hash("EBZ_BEING_ID_V1", bytes(m.world_id, 16), bytes(message.commit, 32)));
      const genome = b64(hash("EBZ_GENOME_V1", bytes(m.world_id, 16), bytes(beingId, 32),
        bytes(message.secret, 32), Buffer.from(round.beacon, "hex")));
      const being = { being_id: beingId, world_id: m.world_id, controller_pk: message.controller,
        genome, mass: 1, complexity: 1, power: 1, skill: 1, stage: 0, devours: 0, fusions: 0,
        mutations: 0, ...initialTraits(genome), nonce: 0, last_event: id,
        history_root: b64(hash("EBZ_HISTORY_V1", bytes(id, 32))), status: "active", hunt: null,
        resource_units: 0, consumed_by: null, pending_evolution: null };
      state.beings[beingId] = being;
      state.histories[beingId] = [{ event_id: id, op: message.op, height }];
      entry.revealed = true;
      state.minted_total++;
      state.live_supply++;
      return;
    }
    const being = state.beings[message.being];
    ensure(being && being.status === "active", "BEING_NOT_ACTIVE");
    ensure(message.controller === being.controller_pk, "UNAUTHORIZED_CONTROLLER");
    ensure(message.prev === being.last_event && message.nonce === add(being.nonce, 1), "STALE_HEAD_OR_NONCE");
    ensure(!being.hunt || message.op === "hunt-resolve", "BEING_LOCKED_IN_HUNT");
    ensure(!being.pending_evolution, "BEING_PENDING_EVOLUTION");
    if (message.op === "hunt-start") {
      ensure(RULESET.scenes.some((scene) => scene.id === message.scene), "UNKNOWN_SCENE");
      being.hunt = { scene: message.scene, height, event_id: id };
    } else if (message.op === "hunt-resolve") {
      ensure(being.hunt, "NO_ACTIVE_HUNT");
      const reward = huntReward(being, being.hunt, height, state.issued_resource_units, m.genesis_height);
      being.resource_units = add(being.resource_units, reward, RULESET.resource_cap_units);
      state.issued_resource_units = add(state.issued_resource_units, reward, RULESET.resource_cap_units);
      being.power = add(being.power, 1, RULESET.max_attribute);
      being.skill = add(being.skill, 1, RULESET.max_attribute);
      being.hunt = null;
    } else if (message.op === "mutate") {
      this._scheduleEvolution(being, id, "mutate", height);
    } else if (message.op === "consume-permit") {
      const target = state.beings[message.consumer];
      ensure(target && target.status === "active" && !target.hunt && !target.pending_evolution && target.being_id !== being.being_id,
        "INVALID_CONSUMER");
      ensure(message.expires >= height, "PERMIT_EXPIRED");
      state.permits[id] = { event_id: id, sacrifice: being.being_id, consumer: message.consumer,
        mode: message.mode, expires: message.expires, authorized_head: id, used: false };
    } else {
      const donor = state.beings[message.sacrifice];
      const permit = state.permits[message.permit];
      ensure(donor && donor.status === "active" && donor.being_id !== being.being_id && !donor.hunt && !donor.pending_evolution,
        "INVALID_SACRIFICE");
      ensure(permit && !permit.used && permit.sacrifice === donor.being_id && permit.consumer === being.being_id &&
        permit.mode === message.op && permit.expires >= height && permit.authorized_head === donor.last_event,
        "INVALID_CONSUME_PERMIT");
      this._scheduleEvolution(being, id, message.op, height, donor);
      donor.status = "consumed";
      donor.consumed_by = being.being_id;
      this._touch(state, donor, id, message.op, height);
      permit.used = true;
      state.live_supply--;
      state.consumed_total++;
    }
    this._touch(state, being, id, message.op, height);
  }

  _select(state, roundId, hashes) {
    const round = state.rounds[roundId];
    if (round.selected !== null) return;
    const window = roundWindow(this.manifest, roundId);
    const beacon = hashes.get(window.beacon_height);
    ensure(beacon, "BEACON_NOT_FINALIZED");
    round.beacon = beacon;
    round.tickets = round.commits.map((id) => ({ event_id: id, ticket: b64(hash("EBZ_MINT_TICKET_V1",
      bytes(this.manifest.world_id, 16), uintLE(roundId), Buffer.from(beacon, "hex"), bytes(id, 32))) }))
      .sort((a, b) => Buffer.compare(bytes(a.ticket, 32), bytes(b.ticket, 32)) ||
        Buffer.compare(bytes(a.event_id, 32), bytes(b.event_id, 32)));
    round.selected = round.tickets.slice(0, Math.min(this.manifest.mint_slots_per_round,
      this.manifest.max_supply - state.minted_total)).map((ticket) => ticket.event_id);
  }

  _touch(state, being, id, op, height) {
    being.nonce = add(being.nonce, 1);
    being.last_event = id;
    being.history_root = b64(hash("EBZ_HISTORY_STEP_V1", bytes(being.history_root, 32), bytes(id, 32)));
    state.histories[being.being_id].push({ event_id: id, op, height });
  }

  _scheduleEvolution(being, id, mode, height, donor) {
    // Overflow is rejected before any sacrifice is consumed, rather than
    // leaving an unresolvable pending evolution at the attribute ceiling.
    if (mode === "fuse" || mode === "devour") {
      const gain = mode === "fuse" ? 2 : 1;
      add(being.mass, gain, RULESET.max_attribute);
      add(being.complexity, gain, RULESET.max_attribute);
      add(mode === "fuse" ? being.fusions : being.devours, 1);
    }
    if (mode === "mutate") add(being.mutations, 1);
    being.pending_evolution = { event_id: id, mode,
      beacon_height: add(height, RULESET.evolution_beacon_delay_blocks, 0xffffffff),
      donor: donor ? { genome: donor.genome, lineage_weights: clone(donor.lineage_weights),
        lineage_mask: donor.lineage_mask } : null };
  }

  snapshot() {
    return { network: "local-regtest-fixture", protocol: "eb-zec", version: "0.1.0",
      observed_height: this.observedHeight, finalized_height: this.finalizedHeight,
      confirmation_depth: this.manifest.confirmation_depth, finality_status: "application-confirmed",
      root: checkpointRoot(this.state.beings), manifest: clone(this.manifest), state: clone(this.state),
      checkpoints: clone(this.checkpoints) };
  }

  round(roundId) {
    const window = roundWindow(this.manifest, roundId);
    const state = clone(this.state);
    const round = state.rounds[roundId];
    if (round && this.finalizedHeight >= window.beacon_height) {
      this._select(state, roundId, new Map(this.chain.filter((block) => block.height <= this.finalizedHeight)
        .map((block) => [block.height, block.hash])));
    }
    return { ...window, ...(state.rounds[roundId] || { commits: [], selected: null }), finalized_height: this.finalizedHeight };
  }
}

module.exports = { Indexer, checkpointRoot, stateRoot };
