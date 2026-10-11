"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const F = require("./offline_fixtures.cjs"), clone = v => JSON.parse(JSON.stringify(v));
if (!process.env.C2C_V2_TEST_DATA_ROOT || !path.isAbsolute(process.env.C2C_V2_TEST_DATA_ROOT)) throw Error("explicit test data root required");
const fixture = JSON.parse(fs.readFileSync(path.join(process.env.C2C_V2_TEST_DATA_ROOT,"new-review-session-cross-language.json"),"utf8"));
function module() {
  const ctx=vm.createContext({ Set,Map,Promise,console });
  vm.runInContext(fs.readFileSync(path.join(F.extensionRoot,"fresh_review_session.js"),"utf8"),ctx);
  return ctx.C2CV2ReviewSessionSetup;
}
function browser(options={}) {
  const cache=options.cache || {}, calls=[], tabs=options.tabs || [{ id:7,url:"https://chatgpt.com/c/old",status:"complete" }];
  let queries=0;
  const chrome={ storage:{session:{async get(k){return clone(cache);},async set(v){calls.push("storage.set");if(options.storageFailure)throw Error("storage_error");Object.assign(cache,clone(v));}}},
    tabs:{async query(){queries++;if(options.race && queries===2)tabs.push({id:100,url:"https://chatgpt.com/",status:"loading"});return clone(tabs);},
      async create(value){calls.push({create:clone(value)});if(options.createFailure)throw Error("creation_uncertain");const t=clone(options.created || {id:99,url:"https://chatgpt.com/",status:"loading"});tabs.push(t);return t;},
      async get(id){calls.push({get:id});return clone(options.loaded || tabs.find(t=>t.id===id));},
      update(){throw Error("navigation forbidden");},reload(){throw Error("reload forbidden");},remove(){throw Error("cleanup forbidden");},sendMessage(){throw Error("send forbidden");}}};
  return {chrome,cache,calls,tabs};
}
const scope = () => ({...clone(fixture.scope),intent:null,binding:null});
const invoke=(m,b,g=fixture.grant,s=scope())=>m.create(b.chrome,clone(g),clone(s),clone(fixture.bridge_identity));
const count=b=>b.calls.filter(x=>x.create).length;
test("new session creates one new native tab without adopting old tab or sending",async()=>{
  const m=module(),b=browser(),before=clone(b.tabs[0]),p=await invoke(m,b);
  assert.equal(p.tab_id,99);assert.deepEqual(Array.from(p.before_tab_ids),[7]);assert.equal(p.grant.nonce,fixture.grant.nonce);
  assert.equal(b.calls[0],"storage.set");assert.equal(count(b),1);assert.deepEqual(b.calls[1].create,{url:"https://chatgpt.com/",active:false});assert.deepEqual(b.tabs[0],before);
  await assert.rejects(invoke(m,b),/already_consumed/);assert.equal(count(b),1);
});
test("wrong nonce authority namespace commit iteration build and root are refused",async()=>{
  for(const [field,value] of [["nonce","invalid"],["namespace","CHROME_R6_20261010_092138"],["review_commit","b".repeat(40)],["iteration",7],["build_id","old"],["root_url","https://chatgpt.com/c/old"],["bridge_session_id","00000000-0000-0000-0000-000000000000"]]){
    const m=module(),b=browser();await assert.rejects(invoke(m,b,{...fixture.grant,[field]:value}),/grant_invalid/);assert.equal(count(b),0);
  }
  const m=module(),b=browser(),s={...scope(),intent:clone(fixture.grant)};
  await assert.rejects(invoke(m,b,{...fixture.grant,nonce:"00000000-0000-0000-0000-000000000001"},s),/grant_invalid/);assert.equal(count(b),0);
});
test("competing and duplicate maintenance commands cannot create twice",async()=>{
  const m=module(),b=browser(),results=await Promise.allSettled([invoke(m,b),invoke(m,b)]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(count(b),1);
});
test("worker restart with durable creation latch never retries uncertain creation",async()=>{
  const b=browser({createFailure:true});await assert.rejects(invoke(module(),b),/creation_uncertain/);assert.equal(count(b),1);
  await assert.rejects(invoke(module(),b),/already_consumed/);assert.equal(count(b),1);
});
test("storage failure before native call is blocked and no browser action occurs",async()=>{
  const m=module(),b=browser({storageFailure:true});await assert.rejects(invoke(m,b),/storage_error/);assert.equal(count(b),0);
  await assert.rejects(invoke(m,b),/already_consumed/);assert.equal(count(b),0);
});
test("existing root and duplicate candidate race are blocked without cleanup or send",async()=>{
  const b=browser({tabs:[{id:7,url:"https://chatgpt.com/",status:"complete"}]});await assert.rejects(invoke(module(),b),/root_ambiguous/);assert.equal(count(b),0);
  const m=module(),r=browser({race:true});await assert.rejects(invoke(m,r),/creation_unconfirmed/);assert.equal(count(r),1);
  await assert.rejects(invoke(m,r),/already_consumed/);assert.equal(count(r),1);
});
test("old ID redirect pending URL and unknown loading status cannot produce a binding",async()=>{
  for(const created of [{id:7,url:"https://chatgpt.com/",status:"loading"},{id:99,url:"https://other.example/",status:"complete"},{id:99,url:"https://chatgpt.com/",pendingUrl:"https://chatgpt.com/c/other",status:"loading"},{id:99,url:"https://chatgpt.com/",status:undefined},{id:true,url:"https://chatgpt.com/",status:"loading"}]){
    const m=module(),b=browser({created});await assert.rejects(invoke(m,b),/unconfirmed/);assert.equal(count(b),1);
    await assert.rejects(invoke(m,b),/already_consumed/);assert.equal(count(b),1);
  }
});
test("Python authority scope and proof restore without any native operation",()=>{
  const m=module();assert.equal(m.validScope(clone(fixture.scope)),true);const p=m.readyProof(fixture.scope);
  assert.equal(p.tab_id,99);assert.equal(p.nonce,fixture.grant.nonce);assert.equal(p.namespace,fixture.scope.namespace);
  const r={target_tab_id:99,task_id:"C2C_V2_CHROME_R6_M3",repo:"huamuyin/codex-with-chatgpt",branch:"codex/c2c-v2-chrome-r6",expected_commit:fixture.scope.review_commit,iteration:6};
  assert.equal(m.validRequest(r,fixture.scope),true);
  for(const change of [{target_tab_id:7},{task_id:"M4"},{expected_commit:"b".repeat(40)},{iteration:7},{repo:"other"},{branch:"other"}])assert.equal(m.validRequest({...r,...change},fixture.scope),false);
  for(const change of [{build_id:"old"},{namespace:"old"},{binding:{...fixture.scope.binding,tab_id:7}},{intent:{...fixture.scope.intent,nonce:"bad"}}])assert.equal(m.validScope({...clone(fixture.scope),...change}),false);
});
