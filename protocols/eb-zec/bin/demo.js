const fs = require("node:fs");
const path = require("node:path");
const { minted, append, command } = require("../test/helpers");
const { canonical, b64, hash } = require("../lib/crypto");
const { renderSvg, metadata, lineageName } = require("../lib/renderer");
const { Indexer } = require("../lib/indexer");

function buildDemo() {
  const c=minted(3),initial=structuredClone(Object.values(c.indexer.state.beings));
  const [a,b,d]=initial;
  const key=(id)=>c.entries.find(entry=>entry.key.controller===c.indexer.state.beings[id].controller_pk).key;
  const current=(id)=>c.indexer.state.beings[id];
  append(c,[command(c,current(a.being_id),"hunt-start",key(a.being_id),{scene:0})]);append(c);
  append(c,[command(c,current(a.being_id),"hunt-resolve",key(a.being_id))]);
  const afterHunt=structuredClone(current(a.being_id));
  append(c,[command(c,current(b.being_id),"consume-permit",key(b.being_id),{consumer:a.being_id,mode:"fuse",expires:100})]);
  append(c,[command(c,current(a.being_id),"fuse",key(a.being_id),{sacrifice:b.being_id,permit:current(b.being_id).last_event})]);
  append(c);append(c);
  const afterFuse=structuredClone(current(a.being_id));
  append(c,[command(c,current(d.being_id),"consume-permit",key(d.being_id),{consumer:a.being_id,mode:"devour",expires:100})]);
  append(c,[command(c,current(a.being_id),"devour",key(a.being_id),{sacrifice:d.being_id,permit:current(d.being_id).last_event})]);
  append(c);append(c);
  const afterDevour=structuredClone(current(a.being_id));
  const forged=command(c,current(a.being_id),"mutate",key(a.being_id),{nonce:999},"invalid-nonce");append(c,[forged]);
  return {c,stages:initial.map((state,i)=>({label:`MINT ${i+1}`,state})).concat([
    {label:"AFTER HUNT",state:afterHunt},{label:"AFTER FUSION",state:afterFuse},{label:"AFTER DEVOUR",state:afterDevour}])};
}

function writeDemo(directory="output") {
  const {c,stages}=buildDemo();
  const replay=new Indexer(c.manifest);replay.append(c.blocks);
  if(canonical(replay.snapshot())!==canonical(c.indexer.snapshot()))throw new Error("Replay mismatch");
  fs.mkdirSync(directory,{recursive:true});
  const fixture={source_kind:"local-fixture",format:"eb-zec-local-chain-v1",manifest:c.manifest,blocks:c.blocks};
  fs.writeFileSync(path.join(directory,"fixture.json"),canonical(fixture)+"\n");
  fs.writeFileSync(path.join(directory,"snapshot.json"),canonical(c.indexer.snapshot())+"\n");
  const cards=stages.map(({label,state},i)=>{
    fs.writeFileSync(path.join(directory,`stage-${i}.svg`),renderSvg(state));
    fs.writeFileSync(path.join(directory,`stage-${i}.metadata.json`),canonical(metadata(state))+"\n");
    return `<article><header>${label}</header><img src="stage-${i}.svg" alt="${label}"><footer>${lineageName(state)}<br>Power ${state.power} / Skill ${state.skill} / Mass ${state.mass}<br>Complexity ${state.complexity} / Fusions ${state.fusions}</footer></article>`;
  }).join("");
  fs.writeFileSync(path.join(directory,"index.html"),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EB-ZEC Local Reference</title><style>*{box-sizing:border-box}body{margin:0;background:#101516;color:#e5eeef;font-family:monospace}header.page{padding:24px;border-bottom:1px solid #34484a}h1{font-size:24px;margin:0 0 12px}main{max-width:1200px;margin:auto;padding:24px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}article{border:1px solid #34484a;border-radius:4px;overflow:hidden}article header,footer{padding:12px;line-height:1.6;font-size:13px}article header{color:#75e2cf;border-bottom:1px solid #34484a}img{display:block;width:100%;aspect-ratio:1}footer{border-top:1px solid #34484a;overflow-wrap:anywhere}@media(max-width:760px){main{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:460px){main{grid-template-columns:minmax(0,1fr);padding:12px}}</style></head><body><header class="page"><h1>ETERNAL BEINGS / EB-ZEC</h1><span>LOCAL FIXTURE / ${c.indexer.state.minted_total} MINTED / ${c.indexer.state.live_supply} ACTIVE / ${c.indexer.state.consumed_total} CONSUMED</span></header><main>${cards}</main></body></html>`);
  return { status:"local-reference-demo-passed",fixture:path.resolve(directory,"fixture.json"),
    gallery:path.resolve(directory,"index.html"),minted:c.indexer.state.minted_total,
    active:c.indexer.state.live_supply,consumed:c.indexer.state.consumed_total,
    resource_units:c.indexer.state.issued_resource_units,resource_kind:"application-ledger-only",
    accepted:Object.values(c.indexer.state.journal).filter(event=>event.status==="accepted").length,
    rejected:Object.values(c.indexer.state.journal).filter(event=>event.status==="rejected").length,
    checkpoint_root:c.indexer.snapshot().root,replay_identical:true,
    svg_hashes:stages.map(({state})=>b64(hash(renderSvg(state)))) };
}

if(require.main===module)try{console.log(JSON.stringify(writeDemo(process.argv[2]||"output"),null,2));}
catch(error){console.error(error.code || error.message);process.exitCode=1;}
module.exports={buildDemo,writeDemo};
