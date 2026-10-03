const test = require("node:test");
const assert = require("node:assert/strict");
const { b64, hash, eventId, canonical, signMessage } = require("../lib/crypto");
const { decodeMemo, encodeMemo } = require("../lib/memo");
const { Indexer } = require("../lib/indexer");
const { manifestHash } = require("../lib/profile");
const { renderSvg } = require("../lib/renderer");
const { fixtureKey, makeManifest, makeTransaction, block, base, start, append, prepareCommit, minted, command } = require("./helpers");

const beings = (c) => Object.values(c.indexer.state.beings);
const keyFor = (c,being) => c.entries.find((entry) => entry.key.controller === being.controller_pk).key;
const record = (c,tx) => c.indexer.state.journal[`${tx.txid}/0`];

test("release is pinned to a signed genesis, immutable manifest and local profile", () => {
  const c = start(); assert.ok(c.indexer.state.genesis_event);
  for (const patch of [{ network: 0 }, { network: 1 }, { ruleset_id: b64(hash("other")) },
    { max_supply: 9999 }, { extra: 1 }, { protocol_ua: "uFake" }]) {
    assert.throws(() => new Indexer({ ...c.manifest, ...patch }));
  }
  const bad = start();
  const tx = makeTransaction(bad.manifest,base(bad.manifest,"world-genesis",{
    manifest: manifestHash(bad.manifest), height: 1, release: bad.manifest.release_key,
  }),fixtureKey(0),"second-genesis");
  append(bad,[tx]); assert.equal(record(bad,tx).error_code,"GENESIS_ALREADY_EXISTS");
});

test("only sufficiently confirmed events affect canonical state", () => {
  const c = start({ confirmation_depth: 2 });
  assert.equal(c.indexer.state.genesis_event,null);
  assert.equal(c.indexer.finalizedHeight,-1);
  append(c); assert.ok(c.indexer.state.genesis_event);
  const e = prepareCommit(c.manifest,fixtureKey(1));
  append(c,[e.commit]); assert.equal(Object.keys(c.indexer.state.commits).length,0);
  append(c); assert.equal(Object.keys(c.indexer.state.commits).length,1);
});

test("oversubscribed Mint fixes tickets at the beacon; only selected commitments reveal", () => {
  const c = minted(3,{ mint_slots_per_round: 1 });
  assert.equal(c.indexer.state.minted_total,1);
  const round = c.indexer.round(0);
  assert.equal(round.selected.length,1);
  assert.equal(round.tickets.length,3);
  const accepted = c.entries.filter((e) => record(c,e.reveal).status === "accepted");
  assert.equal(accepted.length,1); assert.equal(accepted[0].commitId,round.selected[0]);
  assert.equal(c.entries.filter((e) => record(c,e.reveal).error_code === "NOT_SELECTED").length,2);
  const before = canonical(round.selected);
  append(c); assert.equal(canonical(c.indexer.round(0).selected),before);
});

test("commit duplicates, one-operation-per-transaction and wrong world are rejected", () => {
  const c = start(), e = prepareCommit(c.manifest,fixtureKey(1));
  append(c,[e.commit]);
  const duplicate = { ...e.commit, txid: hash("new duplicate tx").toString("hex") };
  append(c,[duplicate]); assert.equal(record(c,duplicate).error_code,"DUPLICATE_CONTROLLER");
  const two = prepareCommit(c.manifest,fixtureKey(2));
  const batched = { ...two.commit, outputs: [two.commit.outputs[0], { ...two.commit.outputs[0], index: 1 }] };
  append(c,[batched]); assert.equal(record(c,batched).error_code,"BATCH_OPERATION_FORBIDDEN");
  assert.equal(Object.keys(c.indexer.state.commits).length,1);
  const wrong = start();
  const other = { ...wrong.manifest, world_id: b64(hash("other-world").subarray(0,16)) };
  const we = prepareCommit(other,fixtureKey(1));
  we.commit.outputs[0].recipient = wrong.manifest.protocol_ua;
  append(wrong,[we.commit]); assert.equal(record(wrong,we.commit).error_code,"WRONG_WORLD");
});

test("wrong secret and out-of-window reveal cannot Mint", () => {
  const c = start(), e = prepareCommit(c.manifest,fixtureKey(1));
  append(c,[e.commit]); append(c); append(c); append(c);
  const reveal = decodeMemo(e.reveal.outputs[0].memo_hex); delete reveal.sig;
  const wrong = makeTransaction(c.manifest,{ ...reveal, secret: b64(hash("wrong")) },e.key,"wrong-secret");
  append(c,[wrong]); assert.equal(record(c,wrong).error_code,"COMMITMENT_MISMATCH");
  append(c); append(c); append(c); append(c,[e.reveal]);
  assert.equal(record(c,e.reveal).error_code,"WRONG_REVEAL_PHASE");
  assert.equal(c.indexer.state.minted_total,0);
});

test("signature authority and exact head/nonce prevent user-assigned attributes and replays", () => {
  const c = minted(1), being = beings(c)[0], key = keyFor(c,being);
  const unauthorized = command(c,being,"mutate",fixtureKey(99));
  append(c,[unauthorized]); assert.equal(record(c,unauthorized).error_code,"UNAUTHORIZED_CONTROLLER");
  const nonce = command(c,being,"mutate",key,{ nonce: 99 });
  append(c,[nonce]); assert.equal(record(c,nonce).error_code,"STALE_HEAD_OR_NONCE");
  const tx = command(c,being,"mutate",key,{},"one-mutation");
  append(c,[tx]); assert.equal(record(c,tx).status,"accepted");
  const replay = { ...tx, txid: hash("replay").toString("hex") };
  append(c,[replay]); assert.equal(record(c,replay).error_code,"STALE_HEAD_OR_NONCE");
  const raw = decodeMemo(tx.outputs[0].memo_hex); delete raw.sig;
  const malicious = signMessage({ ...raw, power: 999999 },key.privateKey);
  const memo = Buffer.alloc(512); memo[0]=255; Buffer.from(canonical(malicious)).copy(memo,1);
  const forged = { txid: hash("forged-power").toString("hex"), outputs: [{ index: 0,
    recipient: c.manifest.protocol_ua, value_zat: 0, memo_hex: memo.toString("hex") }] };
  append(c,[forged]); assert.equal(record(c,forged).error_code,"INVALID_SCHEMA");
  assert.equal(beings(c)[0].power,1);
});

test("Hunt locks all other actions, rejects early resolve and pays exactly once", () => {
  const c = minted(1), key = keyFor(c,beings(c)[0]);
  const begin = command(c,beings(c)[0],"hunt-start",key,{ scene: 0 });
  append(c,[begin]); assert.equal(record(c,begin).status,"accepted");
  const early = command(c,beings(c)[0],"hunt-resolve",key);
  const blocked = command(c,beings(c)[0],"mutate",key);
  append(c,[early,blocked]); assert.equal(record(c,early).error_code,"HUNT_TOO_EARLY");
  assert.equal(record(c,blocked).error_code,"BEING_LOCKED_IN_HUNT");
  const resolve = command(c,beings(c)[0],"hunt-resolve",key,{},"resolve-valid");
  append(c,[resolve]); assert.equal(record(c,resolve).status,"accepted");
  assert.equal(beings(c)[0].resource_units,40);
  assert.equal(beings(c)[0].power,2); assert.equal(beings(c)[0].skill,2);
  assert.equal(c.indexer.state.issued_resource_units,40);
  const again = command(c,beings(c)[0],"hunt-resolve",key,{},"resolve-again");
  append(c,[again]); assert.equal(record(c,again).error_code,"NO_ACTIVE_HUNT");
  assert.equal(c.indexer.state.issued_resource_units,40);
});

test("fusion requires an exact permit; consumes once and never reopens genesis supply", () => {
  const c = minted(2,{ max_supply: 2, mint_slots_per_round: 2 });
  const [a,b] = beings(c), ka=keyFor(c,a), kb=keyFor(c,b);
  const without = command(c,a,"fuse",ka,{ sacrifice: b.being_id, permit: b64(hash("missing")) });
  append(c,[without]); assert.equal(record(c,without).error_code,"INVALID_CONSUME_PERMIT");
  const permit = command(c,b,"consume-permit",kb,{ consumer: a.being_id, mode: "fuse", expires: 50 });
  append(c,[permit]);
  const permitId = record(c,permit).event_id;
  const fuse = command(c,c.indexer.state.beings[a.being_id],"fuse",ka,{ sacrifice: b.being_id, permit: permitId });
  append(c,[fuse]); assert.equal(record(c,fuse).status,"accepted");
  assert.equal(c.indexer.state.beings[b.being_id].status,"consumed");
  assert.ok(c.indexer.state.beings[a.being_id].pending_evolution);
  append(c);append(c);
  assert.equal(c.indexer.state.beings[a.being_id].mass,3);
  assert.equal(c.indexer.state.beings[a.being_id].power,1);
  assert.equal(c.indexer.state.minted_total,2); assert.equal(c.indexer.state.live_supply,1);
  const resurrect = command(c,c.indexer.state.beings[b.being_id],"mutate",kb);
  append(c,[resurrect]); assert.equal(record(c,resurrect).error_code,"BEING_NOT_ACTIVE");
  const nextRound=Math.floor(c.blocks.at(-1).height/8)+1;
  const startHeight=nextRound*8+1;
  while(c.blocks.at(-1).height<startHeight-1)append(c);
  const extra=prepareCommit(c.manifest,fixtureKey(99),nextRound);
  append(c,[extra.commit]); assert.equal(record(c,extra.commit).error_code,"MINT_CAP_REACHED");
});

test("permit expiry, donor state changes, wrong mode and unauthorized consumption fail atomically", () => {
  for (const mode of ["expired","changed","wrong-mode"]) {
    const c=minted(2),[a,b]=beings(c),ka=keyFor(c,a),kb=keyFor(c,b);
    const permit=command(c,b,"consume-permit",kb,{consumer:a.being_id,mode:"fuse",expires:mode==="expired"?6:100});
    append(c,[permit]);
    if(mode==="changed"){
      append(c,[command(c,c.indexer.state.beings[b.being_id],"mutate",kb)]);append(c);append(c);
    }
    const before=c.indexer.snapshot().root;
    const op=mode==="wrong-mode"?"devour":"fuse";
    const tx=command(c,c.indexer.state.beings[a.being_id],op,ka,{sacrifice:b.being_id,permit:record(c,permit).event_id});
    append(c,[tx]);assert.equal(record(c,tx).error_code,"INVALID_CONSUME_PERMIT");
    assert.equal(c.indexer.snapshot().root,before);
    assert.equal(c.indexer.state.live_supply,2);
  }
});

test("devour has modest growth and no fabricated external Ethereum sacrifices", () => {
  const c=minted(2),[a,b]=beings(c),ka=keyFor(c,a),kb=keyFor(c,b);
  const permit=command(c,b,"consume-permit",kb,{consumer:a.being_id,mode:"devour",expires:100});append(c,[permit]);
  const tx=command(c,c.indexer.state.beings[a.being_id],"devour",ka,{sacrifice:b.being_id,permit:record(c,permit).event_id});append(c,[tx]);
  assert.equal(record(c,tx).status,"accepted");append(c);append(c);
  assert.equal(c.indexer.state.beings[a.being_id].mass,2);
  assert.deepEqual(c.indexer.state.beings[a.being_id].lineage_weights,a.lineage_weights);
  const external=command(c,c.indexer.state.beings[a.being_id],"devour",ka,{sacrifice:b64(hash("ETH NFT")),permit:record(c,permit).event_id});
  append(c,[external]);assert.equal(record(c,external).error_code,"INVALID_SACRIFICE");
});

test("rebuild is byte-identical and reorganization rolls back consumed status and rewards", () => {
  const c=minted(2),[a,b]=beings(c),ka=keyFor(c,a),kb=keyFor(c,b);
  append(c,[command(c,b,"consume-permit",kb,{consumer:a.being_id,mode:"fuse",expires:100})]);
  const permit=c.indexer.state.beings[b.being_id].last_event;
  append(c,[command(c,c.indexer.state.beings[a.being_id],"fuse",ka,{sacrifice:b.being_id,permit})]);
  const rebuilt=new Indexer(c.manifest);rebuilt.append(c.blocks);
  assert.equal(canonical(rebuilt.snapshot()),canonical(c.indexer.snapshot()));
  assert.equal(renderSvg(rebuilt.state.beings[a.being_id]),renderSvg(c.indexer.state.beings[a.being_id]));
  const fork=block(c.blocks[6],[],"replacement");c.indexer.replaceFrom(7,[fork]);
  assert.equal(c.indexer.state.beings[b.being_id].status,"active");assert.equal(c.indexer.state.live_supply,2);
  const forkRebuild=new Indexer(c.manifest);forkRebuild.append(c.blocks.slice(0,7).concat([fork]));
  assert.equal(c.indexer.snapshot().root,forkRebuild.snapshot().root);
});

test("chain ordering and duplicate transaction failures leave the prior state untouched", () => {
  const c=minted(1),before=canonical(c.indexer.snapshot());
  const invalid=block(c.blocks.at(-1));invalid.parent_hash="f".repeat(64);
  assert.throws(()=>c.indexer.append([invalid]),/PARENT_HASH_MISMATCH/);
  assert.equal(canonical(c.indexer.snapshot()),before);
  const duplicate=block(c.blocks.at(-1),[c.entries[0].commit]);
  assert.throws(()=>c.indexer.append([duplicate]),/DUPLICATE_OR_INVALID_TXID/);
  assert.equal(canonical(c.indexer.snapshot()),before);
});

test("future V0.5 operations fail closed instead of implying trade settlement", () => {
  const c=minted(1),a=beings(c)[0],ka=keyFor(c,a);
  const tx=command(c,a,"transfer",ka,{to:fixtureKey(99).controller});append(c,[tx]);
  assert.equal(record(c,tx).error_code,"UNSUPPORTED_V0_OPERATION");
  assert.equal(beings(c)[0].controller_pk,a.controller_pk);
});

test("evolution waits for a future beacon, locks retries and replays a changed beacon on reorg",()=>{
  const c=minted(2),[a,b]=beings(c),ka=keyFor(c,a),kb=keyFor(c,b);
  append(c,[command(c,b,"consume-permit",kb,{consumer:a.being_id,mode:"fuse",expires:100})]);
  const permit=c.indexer.state.beings[b.being_id].last_event;
  append(c,[command(c,c.indexer.state.beings[a.being_id],"fuse",ka,{sacrifice:b.being_id,permit})]);
  const pending=c.indexer.state.beings[a.being_id];
  assert.equal(pending.genome,a.genome);assert.equal(pending.mass,1);assert.equal(pending.pending_evolution.beacon_height,9);
  const retry=command(c,pending,"mutate",ka);append(c,[retry]);
  assert.equal(record(c,retry).error_code,"BEING_PENDING_EVOLUTION");
  append(c);
  const final=c.indexer.state.beings[a.being_id];
  assert.equal(final.pending_evolution,null);assert.equal(final.mass,3);assert.notEqual(final.genome,a.genome);
  const replacement=block(c.blocks[8],[],"changed-future-beacon");
  c.indexer.replaceFrom(9,[replacement]);
  assert.notEqual(c.indexer.state.beings[a.being_id].genome,final.genome);
  assert.equal(c.indexer.state.beings[a.being_id].mass,3);
  assert.equal(c.indexer.state.beings[b.being_id].status,"consumed");
});

test("reorg removes Hunt rewards and restores the lock before resolution",()=>{
  const c=minted(1),a=beings(c)[0],ka=keyFor(c,a);
  append(c,[command(c,a,"hunt-start",ka,{scene:0})]);append(c);
  const tx=command(c,beings(c)[0],"hunt-resolve",ka);append(c,[tx]);
  assert.equal(c.indexer.state.issued_resource_units,40);
  c.indexer.replaceFrom(8,[block(c.blocks[7],[],"rollback-reward")]);
  assert.equal(c.indexer.state.issued_resource_units,0);assert.equal(beings(c)[0].resource_units,0);
  assert.equal(beings(c)[0].power,1);assert.ok(beings(c)[0].hunt);
  assert.equal(record(c,tx),undefined);
});

test("missed reveals do not rerank old rounds when a later round Mints",()=>{
  const c=start({mint_slots_per_round:1,max_supply:3}),old=prepareCommit(c.manifest,fixtureKey(1));
  append(c,[old.commit]);while(c.blocks.at(-1).height<8)append(c);
  const selected=canonical(c.indexer.round(0).selected);assert.equal(c.indexer.state.minted_total,0);
  const next=prepareCommit(c.manifest,fixtureKey(2),1);append(c,[next.commit]);
  while(c.blocks.at(-1).height<12)append(c);append(c,[next.reveal]);
  assert.equal(c.indexer.state.minted_total,1);assert.equal(canonical(c.indexer.round(0).selected),selected);
});
