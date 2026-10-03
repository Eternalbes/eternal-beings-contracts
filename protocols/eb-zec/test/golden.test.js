const test=require("node:test");
const assert=require("node:assert/strict");
const {makeVectors}=require("../bin/vectors");
const {canonical}=require("../lib/crypto");

test("published golden fixture matches every canonical state, memo and rendered image hash",()=>{
  const expected=require("../fixtures/golden-v0.1.json");
  assert.equal(canonical(makeVectors()),canonical(expected));
});
