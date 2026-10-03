const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const { createApi } = require("../lib/api");
const { minted, fixtureKey, command } = require("./helpers");
const { decodeMemo } = require("../lib/memo");
const { b64, hash } = require("../lib/crypto");
const { renderSvg } = require("../lib/renderer");

test("read-only local API renders authoritative state and refuses secrets, writes and cross-origin requests",async()=>{
  const c=minted(1),being=Object.values(c.indexer.state.beings)[0],server=createApi(c.indexer);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=(route,body,extra={})=>fetch(url+route,{method:"POST",headers:{"Content-Type":"application/json",...extra},body:JSON.stringify(body)});
  try{
    const network=await(await fetch(url+"/v1/network")).json();assert.equal(network.live_zcash_scanner,false);
    assert.equal(network.broadcast_supported,false);
    const state=await(await fetch(url+`/v1/beings/${being.being_id}`)).json();assert.equal(state.being.power,1);
    assert.equal(await(await fetch(url+`/v1/beings/${being.being_id}/render.svg`)).text(),renderSvg(being));
    const token=await(await fetch(url+`/v1/beings/${being.being_id}/metadata.json`)).json();assert.ok(token.image.startsWith("data:image/svg+xml;base64,"));
    const verified=await(await post("/v1/render/verify",{being_id:being.being_id,svg_hash:b64(hash(renderSvg(being)))})).json();assert.equal(verified.matches,true);
    const tx=command(c,being,"mutate",fixtureKey(1));
    const {sig,...message}=decodeMemo(tx.outputs[0].memo_hex);
    const prepared=await(await post("/v1/prepare/message",{message})).json();assert.equal(prepared.needs_local_signature,true);
    const validated=await(await post("/v1/validate/memo",{memo_hex:tx.outputs[0].memo_hex})).json();
    assert.equal(validated.signature_valid,true);assert.equal(validated.state_authorized,false);
    assert.equal((await post("/v1/prepare/message",{message:{...message,privateKey:"not-a-key"}})).status,400);
    assert.equal((await post("/v1/submit/raw-transaction",{})).status,404);
    assert.equal((await post("/v1/validate/memo",{memo_hex:tx.outputs[0].memo_hex},{Origin:"https://evil.example"})).status,400);
    const invalidHost=await new Promise((resolve,reject)=>{
      const request=http.get(url+"/v1/network",{headers:{Host:"evil.example"}},response=>{
        response.resume();resolve(response.statusCode);
      });request.on("error",reject);
    });
    assert.equal(invalidHost,400);
    assert.equal((await post("/v1/validate/memo",{memo_hex:"a".repeat(18000)})).status,413);
    assert.equal((await fetch(url+"/v1/network?setPower=999")).status,400);
    assert.equal((await fetch(url+"/v1/beings/not-an-id")).status,404);
    assert.equal(c.indexer.state.beings[being.being_id].power,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
