import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AcpClient } from "../plugins/grok-safe/scripts/lib/acp-client.mjs";
import { JobEvents, normalizeGrokEvent } from "../plugins/grok-safe/scripts/lib/events.mjs";
import { parseCliHelp, CliCatalog } from "../plugins/grok-safe/scripts/lib/cli-catalog.mjs";

test("ACP correlates out-of-order responses and concurrent client requests", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});const send=o=>console.log(JSON.stringify({jsonrpc:'2.0',...o}));rl.on('line',l=>{const m=JSON.parse(l);if(m.method==='one'){send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'hello'}}}});send({id:99,method:'fs/read_text_file',params:{path:'test'}});setTimeout(()=>send({id:m.id,result:{name:'one'}}),30)}else if(m.method==='two')send({id:m.id,result:{name:'two'}});else if(m.id===99)send({method:'client-result',params:m.result});});`;
  const client = new AcpClient(process.execPath, ["-e", script], { handler: async () => ({ content: "file" }) });
  const updates = []; client.on("notification", (method, params) => updates.push({ method, params }));
  try {
    const results = await Promise.all([client.request("one"), client.request("two")]);
    assert.deepEqual(results.map(r => r.name), ["one", "two"]);
    assert.ok(updates.some(e => e.method === "client-result" && e.params.content === "file"));
  } finally { client.close(); }
});

test("native ACP events preserve tool identity and text", () => {
  assert.deepEqual(normalizeGrokEvent({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "中文" } } } }), { type: "text", data: "中文" });
  assert.equal(normalizeGrokEvent({ sessionUpdate: "tool_call", toolCallId: "1", title: "Read", rawInput: { path: "x" } }).id, "1");
});

test("event waits wake immediately, preserve cursors and clean up listeners", async () => {
  const events = new JobEvents(); const start = performance.now();
  const wait = events.wait(0, 60000); events.publish("phase", { phase: "editing" });
  assert.equal((await wait).cursor, 1); assert.ok(performance.now() - start < 100);
  assert.equal(events.listenerCount("event"), 0);
  assert.deepEqual(events.since(1).events, []);
});

test("catalog discovers nested CLI help, caches it and defers updates during work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-")), binary = path.join(dir, "grok"); fs.writeFileSync(binary, "fake");
  const calls = [];
  const run = async (_binary, args) => {
    calls.push(args.join(" "));
    const text = args[0] === "version" ? "grok 1.0.30" : args.includes("--check") ? '{"updateAvailable":true}' : args[0] === "agent" && args.length === 2 ? "Commands:\n  stdio  ACP\nOptions:\n  --no-leader" : args[0] === "update" ? "Options:\n  --check\n  --json" : args.length === 1 ? "Options:\n  --prompt-file <FILE>\nCommands:\n  agent  ACP\n  update  Updates" : "Options:\n  --debug";
    return { exitCode: 0, stdout: text, finishedAt: new Date().toISOString() };
  };
  const catalog = new CliCatalog({ stateRoot: dir, binary, run, isBusy: () => true });
  assert.equal((await catalog.refresh()).acp, true); const n = calls.length;
  await catalog.refresh(); assert.equal(calls.length, n);
  assert.equal((await catalog.checkUpdate({ install: true })).deferred, true);
  assert.ok(!calls.includes("update --stable"));
});

test('update check never reinstalls current stable; active external runners defer install', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'update-')),binary=path.join(dir,'grok');fs.writeFileSync(binary,'fake');
 let available=false, installs=0;
 const catalog=new CliCatalog({stateRoot:dir,binary,externalBusy:async()=>true,run:async(_b,args)=>{if(args.includes('--stable'))installs++;return {exitCode:0,stdout:JSON.stringify({updateAvailable:available,currentVersion:'1',latestVersion:available?'2':'1'})}}});
 catalog.cache={binary,fingerprint:catalog.fingerprint(binary),version:'1',pages:{update:{flags:['--check','--json','--stable']}}};
 assert.equal((await catalog.checkUpdate({install:true})).status,'up-to-date');
 available=true;assert.equal((await catalog.checkUpdate({install:true})).deferred,true);
 assert.equal(installs,0);assert.equal(fs.existsSync(path.join(catalog.dir,'update.lock')),false);
});

test('successful stable update immediately rebuilds native command catalog', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'update-')),binary=path.join(dir,'grok');fs.writeFileSync(binary,'fake');
 let installed=false;
 const catalog=new CliCatalog({stateRoot:dir,binary,externalBusy:async()=>false,run:async(_b,args)=>{
 if(args.includes('--stable')){installed=true;return {exitCode:0,stdout:''};}
 if(args.includes('--check'))return {exitCode:0,stdout:'{"updateAvailable":true}'};
 if(args[0]==='version')return {exitCode:0,stdout:installed?'2.0.0':'1.0.0'};
 if(args.length===1)return {exitCode:0,stdout:'Options:\n  --prompt-file <FILE>\nCommands:\n  agent  ACP\n  update  Update'+(installed?'\n  inspect  New inspect':'')};
 if(args[0]==='agent'&&args.length===2)return {exitCode:0,stdout:'Commands:\n  stdio  ACP'};
 return {exitCode:0,stdout:'Options:\n  --check\n  --json\n  --stable'};
 }});
 catalog.protocolCapabilities=async()=>({available:true,agentCapabilities:{_meta:{'x.ai/hooks':true}}});
 await catalog.refresh();const result=await catalog.checkUpdate({install:true});
 assert.equal(result.status,'updated');assert.equal(result.installedVersion,'2.0.0');
 assert.ok(catalog.cache.addedCommands.includes('inspect'));
 assert.match((await catalog.help('inspect')).help,/--check/);
});
