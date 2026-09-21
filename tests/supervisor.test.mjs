import assert from 'node:assert/strict';
import test from 'node:test';
import {GrokSupervisor} from '../plugins/grok-safe/scripts/lib/supervisor.mjs';
import {JobEvents} from '../plugins/grok-safe/scripts/lib/events.mjs';
import {JobPolicy} from '../plugins/grok-safe/scripts/lib/job-policy.mjs';
import {normalizeControlOptions} from '../plugins/grok-safe/scripts/lib/control.mjs';

test('native hook registration routes steering only at supported boundaries', () => {
 const runtime=new GrokSupervisor();runtime.persist=()=>{};
 const worker={job:{},events:new JobEvents(),pendingMessages:[{id:'steer',text:'change direction',delivery:'steer',receivedAt:Date.now()},{id:'queue',text:'later',delivery:'queue',receivedAt:Date.now()}],policy:{before:()=>({decision:'allow'}),after:()=>({}),stop:()=>({})}};
 assert.equal(runtime.handleHook(worker,{hookEventName:'pre_tool_use'}).decision,'continue');
 assert.equal(worker.pendingMessages.length,2);
 const reply=runtime.handleHook(worker,{hookEventName:'post_tool_use'});
 assert.equal(reply.additionalContext,'change direction');assert.equal(worker.pendingMessages[0].id,'queue');
 assert.equal(worker.events.entries.filter(e=>e.type==='message-delivered').length,1);
});
test('native hook policy denial is a valid denial response rather than transport failure', () => {
 const runtime=new GrokSupervisor();runtime.persist=()=>{};
 const worker={job:{},events:new JobEvents(),pendingMessages:[],policy:{before:()=>{throw new Error('outside scope')}}};
 assert.deepEqual(runtime.handleHook(worker,{hookEventName:'pre_tool_use'}).decision,'deny');
});
test('unknown tool names cannot silently bypass capability policy', () => {
 const policy=new JobPolicy({executionPath:process.cwd(),control:normalizeControlOptions({}),acceptance:{},write:false});
 assert.throws(()=>policy.before({toolName:'unrecognized_remote_tool'}),/not been authorized/);
 assert.throws(()=>policy.before({toolName:'write',toolInput:{file_path:'x'}}),/Read-only/);
});
test('native list_dir and scoped git diff are allowed while shell operators stay denied', () => {
 const policy=new JobPolicy({executionPath:process.cwd(),control:normalizeControlOptions({}),acceptance:{capabilities:['read']},write:false});
 assert.doesNotThrow(()=>policy.before({toolName:'list_dir',toolInput:{target_directory:process.cwd()}}));
 policy.after({toolName:'list_dir'});
 assert.doesNotThrow(()=>policy.before({toolName:'run_terminal_command',toolInput:{command:'git diff -- plugins/grok-safe/scripts/lib/events.mjs'}}));
 assert.throws(()=>policy.before({toolName:'run_terminal_command',toolInput:{command:'git status && git diff'}}),/outside permitted/);
});

test('filesystem callback validation does not count one logical read twice', () => {
 const policy=new JobPolicy({executionPath:process.cwd(),control:normalizeControlOptions({}),acceptance:{capabilities:['read']},write:false});
 const file='plugins/grok-safe/scripts/lib/usage.mjs';
 policy.before({toolName:'read_file',toolInput:{target_file:file}});
 policy.inspectFile(file,{track:false});
 assert.equal(policy.metrics.readVersions,1);assert.equal(policy.metrics.duplicateReads,0);
});
test('stop hook sends an active continuation for pending steering',()=>{
 const runtime=new GrokSupervisor();runtime.persist=()=>{};
 const worker={job:{},events:new JobEvents(),pendingMessages:[{id:'1',text:'finish missing output',delivery:'steer',receivedAt:Date.now()}],policy:{stop:()=>({})}};
 const reply=runtime.handleHook(worker,{hookEventName:'stop'});
 assert.equal(reply.decision,'block');assert.equal(reply.systemMessage,'finish missing output');
});

test('live session configuration uses the string wire value accepted by Grok 1.0.30',async()=>{
 const runtime=new GrokSupervisor();const calls=[];
 const worker={job:{workspaceRoot:process.cwd(),grokSessionId:'session'},events:new JobEvents(),client:{request:async(method,params)=>{calls.push({method,params});return {configOptions:[]}}}};
 runtime.workers.set('job',worker);
 await runtime.configure(process.cwd(),'job','reasoning_effort','low');
 assert.equal(calls[0].params.value,'low');assert.equal(calls[0].method,'session/set_config_option');
});
