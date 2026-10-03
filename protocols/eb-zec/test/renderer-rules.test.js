const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { renderSvg, metadata, rendererId } = require("../lib/renderer");
const { RULESET, initialTraits, mixLineages, evolve, huntReward, roll } = require("../lib/rules");
const { b64, hash, canonical, add } = require("../lib/crypto");
const { minted } = require("./helpers");
const BEACON = hash("future-test-beacon").toString("hex");

test("SVG and metadata are deterministic across calls and independent Node processes", () => {
  const state=Object.values(minted(1).indexer.state.beings)[0];
  assert.equal(renderSvg(state),renderSvg(structuredClone(state)));
  const child=spawnSync(process.execPath,["-e",'const fs=require("fs");const {renderSvg}=require("./lib/renderer");process.stdout.write(renderSvg(JSON.parse(fs.readFileSync(0,"utf8"))));'],
    {cwd:require("node:path").join(__dirname,".."),input:canonical(state),encoding:"utf8"});
  assert.equal(child.status,0);assert.equal(child.stdout,renderSvg(state));
  assert.equal(canonical(metadata(state)),canonical(metadata(structuredClone(state))));
  assert.equal(rendererId().length,43);
  assert.ok(!/<script|https?:|foreignObject|onload|<image|<animate/i.test(renderSvg(state).replace('xmlns="http://www.w3.org/2000/svg"',"")));
});

test("six initial families differ and start small with no decorative frame", () => {
  const source=Object.values(minted(1).indexer.state.beings)[0],svg=[];
  for(let family=0;family<6;family++){
    const genome=hash("family",String(family));genome[0]=family;
    const state={...source,genome:b64(genome),...initialTraits(b64(genome))};
    const image=renderSvg(state);assert.ok(!image.includes('x="18"'));
    assert.ok(image.length<1300);svg.push(image);
  }
  assert.equal(new Set(svg).size,6);
});

test("hybrids transform shape; A+B and AB+A differ without exploding attributes", () => {
  const [source,donor]=Object.values(minted(2).indexer.state.beings);
  const a={...source,lineage_weights:[10000,0,0,0,0,0],lineage_mask:1};
  const b={...donor,lineage_weights:[0,0,0,10000,0,0],lineage_mask:8};
  const ab=structuredClone(a);evolve(ab,b64(hash("fusion1")),"fuse",b,BEACON);
  const aba=structuredClone(ab);evolve(aba,b64(hash("fusion2")),"fuse",a,BEACON);
  assert.notDeepEqual(ab.lineage_weights,aba.lineage_weights);
  assert.notEqual(renderSvg(a),renderSvg(ab));assert.notEqual(renderSvg(ab),renderSvg(aba));
  assert.equal(ab.mass,3);assert.equal(ab.power,1);
  assert.equal(ab.lineage_weights.reduce((a,b)=>a+b,0),10000);
  assert.deepEqual(mixLineages([10000,0,0,0,0,0],[0,10000,0,0,0,0]),[7500,2500,0,0,0,0]);
});

test("rare glyphs and frame persist, first glyph award is one row, all rendering stays bounded", () => {
  const source=Object.values(minted(1).indexer.state.beings)[0];
  let first;
  for(let i=0;i<5000;i++){
    const state=structuredClone(source);evolve(state,b64(hash("trait-test",String(i))),"fuse",source,BEACON);
    if(state.glyph_rows){first=state;break;}
  }
  assert.ok(first);assert.equal(first.glyph_rows,1);
  first.border=true;evolve(first,b64(hash("next")),"devour",source,BEACON);
  assert.equal(first.border,true);assert.ok(first.glyph_rows>=1);
  const maximal={...first,stage:3,glyph_rows:32,complexity:4294967295};
  const image=renderSvg(maximal);assert.ok(image.length<20000);assert.ok(image.includes('font-size="13"'));
  assert.throws(()=>renderSvg({...maximal,glyph_rows:100000}),/INVALID_RENDER_STATE/);
});

test("resource issuance is capped globally, late hunts have bounded output and attributes cannot overflow", () => {
  const being=Object.values(minted(1).indexer.state.beings)[0],hunt={scene:0,height:1};
  assert.equal(huntReward(being,hunt,3,0,0),40);
  assert.equal(huntReward(being,hunt,9999,0,0),40);
  assert.equal(huntReward(being,hunt,3,2999,0),1);
  assert.equal(huntReward(being,hunt,3,3000,0),0);
  assert.equal(huntReward(being,hunt,9999,RULESET.resource_cap_units,0),0);
  assert.throws(()=>huntReward(being,hunt,1,0,0),/HUNT_TOO_EARLY/);
  assert.throws(()=>add(Number.MAX_SAFE_INTEGER,1),/INTEGER_OVERFLOW/);
  assert.throws(()=>add(4294967295,1,RULESET.max_attribute),/INTEGER_OVERFLOW/);
  assert.ok(Object.isFrozen(RULESET.scenes[0]));
  for(let i=0;i<100;i++){const value=roll(hash(String(i)),"check");assert.ok(value>=0&&value<10000);}
});
