import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobEvents } from '../plugins/grok-safe/scripts/lib/events.mjs';
import { GrokSupervisor, publicExecution } from '../plugins/grok-safe/scripts/lib/supervisor.mjs';
import { listToolDefinitions } from '../plugins/grok-safe/mcp/server.mjs';

test('compact wait ignores telemetry but immediately delivers a permission denial', async () => {
  const events = new JobEvents();
  let settled = false;
  const wait = events.wait(0, 1000, undefined, true).then(value => { settled = true; return value; });
  events.publish('thought', { data: 'thinking' });
  events.publish('text', { data: 'working' });
  events.publish('tool_call', { status: 'in_progress', input: { huge: 'x'.repeat(50000) } });
  await Promise.resolve();
  assert.equal(settled, false);
  events.publish('permission-denied', { reason: 'outside scope' });
  const result = await wait;
  assert.deepEqual(result.events.map(e => e.type), ['permission-denied']);
  assert.equal(result.cursor, 4);
  assert.equal(events.listenerCount('event'), 0);
  assert.equal(events.since(0).events.length, 4);
});

test('important evidence survives telemetry flooding and restart; gaps are explicit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-events-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const events = new JobEvents(file, 3);
    events.publish('permission-denied', { reason: 'protected file' });
    for (let i = 0; i < 20; i++) events.publish('thought', { data: 'noise' });
    assert.equal(events.since(0, true).events[0].type, 'permission-denied');
    await events.flush();
    const restored = await JobEvents.load(file, 3);
    assert.equal(restored.since(0, true).events[0].type, 'permission-denied');
    for (let i = 0; i < 4; i++) restored.publish('warning', { message: String(i) });
    assert.equal(restored.since(0, true).gap, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure, retry, watchdog, delivery and unknown events stay visible; full mode remains available', async () => {
  const events = new JobEvents();
  const types = ['acceptance-retry', 'watchdog-warning', 'message-delivered', 'finished', 'future-event'];
  for (const type of types) events.publish(type);
  events.publish('tool_call_update', { status: 'failed', output: 'evidence' });
  assert.equal(events.since(0, true).events.length, 6);
  const cursor = events.revision;
  const wait = events.wait(cursor, 1000);
  events.publish('thought', { data: 'raw debug' });
  assert.equal((await wait).events[0].data, 'raw debug');
});

test('timeout and cancellation clean listeners without losing the latest cursor', async () => {
  const events = new JobEvents();
  events.publish('text', { data: 'noise' });
  assert.equal((await events.wait(0, 5, undefined, true)).cursor, 1);
  const abort = new AbortController();
  const wait = events.wait(1, 1000, abort.signal, true);
  abort.abort();
  await wait;
  assert.equal(events.listenerCount('event'), 0);
});

test('compact snapshots preserve review evidence and failures without replaying large context', () => {
  const job = { id: 'sample', workspaceRoot: process.cwd(), write: true, status: 'completed',
    prompt: 'p'.repeat(2000), checkpoint: { readFiles: ['x'.repeat(20000)] }, resultText: 'r'.repeat(10000),
    changedFiles: [{ path: 'code.mjs', status: 'modified' }], untrackedFiles: ['new.mjs'], baseCommit: 'base', finalHead: 'head',
    acceptance: { requiredCommands: ['test'] }, acceptancePassed: false,
    tests: [{ command: 'test', exitCode: 1, stdout: 'failure details', stderr: 'error' }, { command: 'ok', exitCode: 0, stdout: 'x'.repeat(4000) }] };
  const full = publicExecution(job);
  const summary = publicExecution(job, 'summary');
  assert.deepEqual(summary.changedFiles, job.changedFiles);
  assert.deepEqual(summary.untrackedFiles, job.untrackedFiles);
  assert.deepEqual(summary.tests[0], job.tests[0]);
  assert.equal(summary.tests[1].exitCode, 0);
  assert.equal(summary.tests[1].stdout, undefined);
  assert.equal(summary.acceptancePassed, false);
  assert.ok(summary.reviewRequired && summary.evidenceFile && summary.eventsFile);
  assert.equal(summary.resultTextTruncated, true);
  assert.equal(full.resultText.length, 10000);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 5);
  const events = new JobEvents();
  events.publish('thought', { data: 'large raw trace' });
  const runtime = new GrokSupervisor();
  const worker = { job, events, policy: { metrics: {} } };
  assert.deepEqual(runtime.snapshot(worker).events, []);
  assert.equal(runtime.snapshot(worker, 0, 'full').events.length, 1);
  assert.deepEqual(runtime.snapshot(worker, events.revision, 'full').events, []);
});

test('MCP exposes summary/full and cursor consistently on all read endpoints', () => {
  for (const name of ['grok_wait', 'grok_events', 'grok_status', 'grok_result']) {
    const schema = listToolDefinitions().find(tool => tool.name === name).inputSchema.properties;
    assert.deepEqual(schema.detail.enum, ['summary', 'full']);
    assert.equal(schema.cursor.minimum, 0);
  }
});

test('real permission hook denial and tool failure wake compact supervision', async () => {
  const runtime = new GrokSupervisor();
  runtime.persist = () => {};
  const worker = { job: {}, events: new JobEvents(), pendingMessages: [], policy: {
    before: () => { throw new Error('protected file'); }, after: () => ({})
  } };
  const waiting = worker.events.wait(0, 1000, undefined, true);
  assert.equal(runtime.handleHook(worker, { hookEventName: 'pre_tool_use', toolName: 'write' }).decision, 'deny');
  assert.equal((await waiting).events[0].type, 'supervision-blocked');
  const cursor = worker.events.revision;
  runtime.handleHook(worker, { hookEventName: 'post_tool_use_failure', toolName: 'read', error: 'missing' });
  assert.equal(worker.events.since(cursor, true).events[0].type, 'tool-failed');
});
