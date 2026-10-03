const fs = require("node:fs");
const path = require("node:path");
const { buildDemo } = require("./demo");
const { b64, hash, canonical } = require("../lib/crypto");
const { renderSvg } = require("../lib/renderer");
const { decodeMemo } = require("../lib/memo");

function makeVectors() {
  const {c,stages}=buildDemo();
  return { format:"eb-zec-local-golden-v1",warning:"LOCAL TEST FIXTURE; CONTROL KEYS ARE PUBLIC; NEVER SEND FUNDS",
    fixture:{source_kind:"local-fixture",format:"eb-zec-local-chain-v1",manifest:c.manifest,blocks:c.blocks},
    expected:{root:c.indexer.snapshot().root,minted_total:c.indexer.state.minted_total,live_supply:c.indexer.state.live_supply,
      consumed_total:c.indexer.state.consumed_total,issued_resource_units:c.indexer.state.issued_resource_units,
      journal:Object.values(c.indexer.state.journal).map(({event_id,status,error_code,op})=>({
        event_id:event_id||null,status,error_code:error_code||null,op})),
      renders:stages.map(({label,state})=>({label,state,svg_hash:b64(hash(renderSvg(state)))}))},
    memos:c.blocks.flatMap(block=>block.transactions.flatMap(tx=>tx.outputs.map(output=>({
      txid:tx.txid,output_index:output.index,height:block.height,memo_hex:output.memo_hex,
      decoded:decodeMemo(output.memo_hex)})))) };
}

if(require.main===module){
  fs.mkdirSync(path.join(__dirname,"../fixtures"),{recursive:true});
  fs.writeFileSync(path.join(__dirname,"../fixtures/golden-v0.1.json"),canonical(makeVectors())+"\n");
  console.log("Public golden fixture generated; no private key or spending material included.");
}
module.exports={makeVectors};
