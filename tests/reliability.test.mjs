import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GrokSupervisor, publicExecution } from '../plugins/grok-safe/scripts/lib/supervisor.mjs';
import { JobEvents } from '../plugins/grok-safe/scripts/lib/events.mjs';
import { AcpClient } from '../plugins/grok-safe/scripts/lib/acp-client.mjs';
import { JobPolicy } from '../plugins/grok-safe/scripts/lib/job-policy.mjs';
import { normalizeControlOptions } from '../plugins/grok-safe/scripts/lib/control.mjs';
import { verifyInstallation, preflightExecution } from '../plugins/grok-safe/scripts/lib/preflight.mjs';
import { acquireExecutionLock } from '../plugins/grok-safe/scripts/lib/execution-lock.mjs';
import { gitEvidence, snapshotWorkspace } from '../plugins/grok-safe/scripts/lib/acceptance.mjs';
import { writeJobFile, resolveJobsDir } from '../plugins/grok-safe/scripts/lib/jobs.mjs';
import { CliCatalog } from '../plugins/grok-safe/scripts/lib/cli-catalog.mjs';
process.env.GROK_CODEX_PLUGIN_STATE = path.resolve(`.test-tmp/reliability-state-${process.pid}`);
const testRoot = path.resolve('.test-tmp'); fs.mkdirSync(testRoot, { recursive: true });

function repo() {
  const cwd = fs.mkdtempSync(path.join(testRoot, 'reliability-'));
  gitEvidence(cwd, ['init']); gitEvidence(cwd, ['config', 'user.name', 'Test']); gitEvidence(cwd, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'before\n'); gitEvidence(cwd, ['add', '.']); gitEvidence(cwd, ['commit', '-m', 'base']);
  return cwd;
}

test('installation and executable preflight fail before model dispatch', () => {
  assert.equal(verifyInstallation().verified, true);
  assert.throws(() => verifyInstallation(path.join(os.tmpdir(), 'missing-verifier-xyz.mjs')), /INSTALLATION_INCOMPLETE/);
  assert.throws(() => preflightExecution(process.cwd(), { requiredCommands: ['nonexistent-executable-xyz'] }, normalizeControlOptions({})), /EXECUTABLE_MISSING/);
});

test('workspace lock excludes a second job and can be released', () => {
  const cwd = repo(), dir = path.join(cwd, '.locks');
  const release = acquireExecutionLock(dir, cwd, 'one');
  assert.throws(() => acquireExecutionLock(dir, cwd, 'two'), /WORKSPACE_BUSY/);
  release(); acquireExecutionLock(dir, cwd, 'two')();
});

test('full installed-style execution includes real verifier subprocess and independent evidence', async () => {
  const cwd = repo(), fixture = path.join(testRoot, `acp-delivery-${Date.now()}.cjs`);
  fs.writeFileSync(fixture, `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n'); let promptId;
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{_meta:{'x.ai/hooks':true}}}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'fixture'}});
 else if(m.method==='session/prompt'){promptId=m.id;send({id:100,method:'fs/write_text_file',params:{path:'source.txt',content:'after\\n'}});}
 else if(m.id===100){if(m.error)throw Error(m.error.message);send({id:101,method:'_x.ai/hooks/run',params:{hookEventName:'stop',lastAssistantMessage:'implemented'}});}
 else if(m.id===101)send({id:promptId,result:{stopReason:'end_turn'}});
});`);
  const runtime = new GrokSupervisor({ catalog: { refresh: async () => ({ acp: true, binary: 'fixture', version: '1.0.30' }) },
    clientFactory: (_binary, _args, options) => new AcpClient(process.execPath, [fixture], options) });
  try {
    const result = await runtime.start(cwd, { prompt: 'Modify source.txt', background: false, acceptance: { allowedPaths: ['source.txt'], requireTests: true, requiredCommands: ['git diff --check'] } });
    assert.equal(result.status, 'completed', JSON.stringify(result.error || result.infrastructureErrors)); assert.equal(result.testStatus, 'passed'); assert.equal(result.reviewStatus, 'pending');
    assert.equal(result.tests[0].exitCode, 0); assert.equal(result.artifactStatus, 'produced');
    assert.equal(fs.readFileSync(path.join(cwd, 'source.txt'), 'utf8'), 'before\n');
    assert.equal(fs.readFileSync(path.join(result.executionPath, 'source.txt'), 'utf8'), 'after\n');
    assert.ok(result.environment === undefined); assert.ok(result.evidenceFile);
  } finally { runtime.close(); }
});

test('messages arriving during verification are delivered before completion', async () => {
  const cwd = repo(); let releaseVerifier, enteredVerifier; let prompts = 0;
  const entered = new Promise(r => { enteredVerifier = r; });
  const verification = new Promise(r => { releaseVerifier = r; });
  let runtime, worker;
  class Client extends EventEmitter {
    closed = false;
    initialize() { return Promise.resolve({ agentCapabilities: { _meta: { 'x.ai/hooks': true } } }); }
    request(method) {
      if (method === 'session/new') return Promise.resolve({ sessionId: 'late-session' });
      if (method === 'session/prompt') { prompts++; worker.observedHooks.add('stop'); }
      return Promise.resolve({ stopReason: 'end_turn' });
    }
    close() { this.closed = true; }
  }
  runtime = new GrokSupervisor({ catalog: { refresh: async () => ({ acp: true, version: '1.0.30' }) }, clientFactory: () => new Client(),
    verifier: async () => { enteredVerifier(); await verification; return { status: 'completed', acceptancePassed: true }; } });
  runtime.persist = () => {};
  const job = { id: 'late', workspaceRoot: cwd, executionPath: cwd, kind: 'task', status: 'running', control: {}, acceptance: {}, runtime: { maxRecoveryAttempts: 0 }, prompt: 'initial' };
  worker = { job, input: {}, events: new JobEvents(), pendingMessages: [], consumedIds: new Set(), policy: { metrics: {}, context: {}, setPhase() {}, checkTime() {} } };
  runtime.workers.set(job.id, worker);
  try {
    const done = runtime.run(worker); await entered;
    assert.equal((await runtime.send(cwd, job.id, { messageId: 'followup', delivery: 'queue', text: 'also do this' })).status, 'received');
    releaseVerifier(); await done;
    assert.equal(prompts, 2); assert.equal(worker.pendingMessages.length, 0);
    assert.equal(job.messages.followup.status, 'acknowledged');
  } finally { runtime.close(); }
});

test('dead owner is reconciled and historical events are labeled', async () => {
  const cwd = repo(), id = 'dead-owner';
  const job = { id, workspaceRoot: cwd, executionPath: cwd, transport: 'acp', status: 'running', pid: 99999999, acceptance: {}, initialSnapshot: snapshotWorkspace(cwd) };
  writeJobFile(cwd, job);
  const events = new JobEvents(path.join(resolveJobsDir(cwd), `${id}.events.jsonl`)); events.publish('phase', { round: 1 }); await events.flush();
  const result = await new GrokSupervisor().wait(cwd, id, 0, 60000);
  assert.equal(result.status, 'interrupted'); assert.equal(result.liveConnection, false);
  assert.equal(result.events[0].replayed, true); assert.equal(result.eventSource, 'history');
});

test('verifier crash preserves outputs and retry invokes no model', async () => {
  const cwd = repo(), job = { id: 'retry', workspaceRoot: cwd, executionPath: cwd, status: 'incomplete', write: true, check: true,
    control: normalizeControlOptions({}), acceptance: { allowedPaths: ['source.txt'], requiredCommands: ['git diff --check'] }, initialSnapshot: snapshotWorkspace(cwd) };
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'after\n');
  const runtime = new GrokSupervisor({ verifier: async () => { throw new Error('verification worker missing'); } });
  const failure = await runtime.verify({ job }, true, 0); Object.assign(job, failure); writeJobFile(cwd, job);
  assert.equal(failure.implementationStatus, 'reported-complete'); assert.equal(failure.testStatus, 'infrastructure-error');
  const retry = await new GrokSupervisor().retryVerification(cwd, job.id);
  assert.equal(retry.acceptancePassed, true); assert.equal(retry.reviewStatus, 'pending'); assert.equal(retry.integrationStatus, 'not-merged');
});

test('batch wait wakes for the second job and cleans every listener', async () => {
  const cwd = process.cwd(), runtime = new GrokSupervisor();
  for (const id of ['a', 'b']) runtime.workers.set(id, { job: { id, workspaceRoot: cwd, status: 'running' }, events: new JobEvents(), policy: { metrics: {} } });
  const waiting = runtime.waitMany(cwd, [{ jobId: 'a' }, { jobId: 'b' }]);
  runtime.workers.get('b').events.publish('permission-denied', { reason: 'denied' });
  const result = await waiting; assert.equal(result.jobs[1].events[0].type, 'permission-denied');
  for (const worker of runtime.workers.values()) assert.equal(worker.events.listenerCount('event'), 0);
});

test('large events page without skipping evidence; summaries use explicit references', () => {
  const events = new JobEvents(); for (let i = 0; i < 50; i++) events.publish('warning', { details: 'x'.repeat(10000) });
  const first = events.since(0, true), second = events.since(first.cursor, true);
  assert.equal(first.cursor, 24); assert.equal(second.cursor, 48); assert.equal(first.events[0].detailsOmitted, true);
  assert.ok(JSON.stringify(first).length < 15000);
  const summary = publicExecution({ id: 'big', workspaceRoot: process.cwd(), tests: Array.from({ length: 100 }, () => ({ exitCode: 1, stderr: 'x'.repeat(4000) })) }, 'summary');
  assert.equal(summary.tests.omitted, true); assert.ok(summary.referencedFields.includes('tests'));
});

test('metrics distinguish unknown turns, actions and unique files', () => {
  const cwd = repo(), policy = new JobPolicy({ executionPath: cwd, write: true, acceptance: {}, control: normalizeControlOptions({}) });
  assert.equal(policy.metrics.turns, null);
  policy.before({ toolName: 'read', toolInput: { path: 'source.txt' } }); policy.after({ toolName: 'read' });
  policy.before({ toolName: 'read', toolInput: { path: 'source.txt' } }); policy.after({ toolName: 'read' });
  assert.equal(policy.metrics.operationsStarted, 2); assert.equal(policy.metrics.operationsCompleted, 2); assert.equal(policy.metrics.filesRead, 1);
  policy.stop({}); assert.equal(policy.metrics.turns, 1);
});

test('ACP refuses an unsupported protocol handshake', async () => {
  const client = new AcpClient(process.execPath, ['-e', `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify({id:m.id,result:{protocolVersion:99}}))})`]);
  try { await assert.rejects(client.initialize(), /ACP_PROTOCOL_UNSUPPORTED/); } finally { client.close(); }
});

test('concurrency limit queues a preflighted job and starts it when a slot opens', async () => {
  let preflightCalls = 0;
  const runtime = new GrokSupervisor({ catalog: {}, maxConcurrent: 1, preflight: () => { preflightCalls++; return { installation: {} }; } });
  runtime.workers.set('one', { job: { status: 'running' } });
  const queued = await runtime.start(process.cwd(), { prompt: 'another', readOnly: true });
  const worker = runtime.workers.get(queued.jobId);
  assert.equal(queued.status, 'queued');
  assert.equal(worker.launched, false);
  assert.equal(preflightCalls, 2);
  let launched = null;
  runtime.launch = candidate => { launched = candidate; candidate.launched = true; candidate.job.status = 'running'; };
  runtime.workers.get('one').job.status = 'completed';
  runtime.pumpQueue();
  assert.equal(launched, worker);
  runtime.close();
});

test('minimal command discovery defers unrelated help until requested', async () => {
  const dir = fs.mkdtempSync(path.join(testRoot, 'minimal-catalog-')), binary = path.join(dir, 'grok'); fs.writeFileSync(binary, 'mock');
  const calls = [];
  const catalog = new CliCatalog({ stateRoot: dir, binary, run: async (_binary, args) => {
    calls.push(args.join(' '));
    return { exitCode: 0, stdout: args[0] === 'version' ? '1.0.30' : args.length === 1 ? 'Commands:\n  agent  ACP\n  update  Update\n  expensive  Optional' : args[0] === 'agent' && args.length === 2 ? 'Commands:\n  stdio  ACP' : 'Options:\n  --check\n  --json\n  --stable' };
  } });
  await catalog.refresh(false, true); assert.equal(calls.includes('expensive --help'), false);
  await catalog.help('expensive'); assert.equal(calls.includes('expensive --help'), true);
});

test('update cannot claim compatibility from help flags when hooks disappear', async () => {
  const dir = fs.mkdtempSync(path.join(testRoot, 'incompatible-update-')), binary = path.join(dir, 'grok'); fs.writeFileSync(binary, 'mock');
  const catalog = new CliCatalog({ stateRoot: dir, binary, externalBusy: async () => false, run: async (_binary, args) => ({ exitCode: 0, stdout: args.includes('--check') ? '{"updateAvailable":true}' : '' }) });
  catalog.cache = { binary, version: '1.0.30', acp: true, pages: { '': { flags: ['--prompt-file'] }, update: { flags: ['--check', '--json', '--stable'] } } };
  catalog.refresh = async () => catalog.cache;
  catalog.protocolCapabilities = async () => ({ available: true, agentCapabilities: {} });
  const result = await catalog.checkUpdate({ install: true });
  assert.equal(result.status, 'update-failed'); assert.equal(result.compatible, false); assert.equal(result.recoveryRequired, true);
});
