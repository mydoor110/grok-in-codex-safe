import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gitEvidence, snapshotWorkspace, verifyDelivery, summarizeTests, writeArtifactManifest, assertPreviousStage, writeReviewAttestation } from '../plugins/grok-safe/scripts/lib/acceptance.mjs';
import { preflightExecution, executeCleanup } from '../plugins/grok-safe/scripts/lib/preflight.mjs';
import { GrokSupervisor } from '../plugins/grok-safe/scripts/lib/supervisor.mjs';
import { JobPolicy } from '../plugins/grok-safe/scripts/lib/job-policy.mjs';
import { JobEvents } from '../plugins/grok-safe/scripts/lib/events.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  gitEvidence(cwd, ['init']);
  gitEvidence(cwd, ['config', 'user.name', 'Test']);
  gitEvidence(cwd, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'before\n');
  gitEvidence(cwd, ['add', '.']);
  gitEvidence(cwd, ['commit', '-m', 'base']);
  const job = { id: 'integrity', workspaceRoot: cwd, executionPath: cwd, write: true,
    initialSnapshot: snapshotWorkspace(cwd), acceptance: { expectedChange: true } };
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'after\n');
  return { cwd, job };
}

test('artifact persistence failure fails every completion indicator', () => {
  const { cwd, job } = fixture();
  fs.writeFileSync(path.join(cwd, 'artifacts'), 'not a directory');
  const result = verifyDelivery(job, true, 0);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.taskCompleted, false);
  assert.equal(result.acceptancePassed, false);
  assert.equal(result.progress.verificationSummary.passed, false);
  assert.equal(result.deliveryError.code, 'ARTIFACT_PERSIST_FAILED');
  assert.equal(result.stageResult, null);
});

test('durable report contains source, command, acceptance and cleanup evidence', () => {
  const { cwd, job } = fixture();
  job.acceptance.requiredCommands = ['node --version'];
  const expectedDiffHash = createHash('sha256').update(gitEvidence(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).digest('hex');
  const result = verifyDelivery(job, true, 0);
  const report = JSON.parse(fs.readFileSync(path.join(cwd, result.stageResult)));
  assert.equal(report.status, 'completed');
  assert.equal(report.diffHash, expectedDiffHash);
  assert.equal(report.sourceCommit, job.initialSnapshot.head);
  assert.equal(report.sourceTreeHash, result.sourceTreeHash);
  assert.deepEqual(report.tests, result.tests);
  assert.deepEqual(report.cleanup, result.cleanup);
  assert.deepEqual(report.acceptanceFailures, []);
  assert.equal(report.finalSnapshot, undefined);
  assert.deepEqual(result.finalSnapshot, snapshotWorkspace(cwd));
  for (const entry of result.artifacts.manifest.files) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(cwd, result.artifacts.dir, entry.path))).digest('hex'), entry.sha256);
  }
});

test('failed report retry invalidates previously successful stage result', () => {
  const { cwd, job } = fixture();
  const first = verifyDelivery(job, true, 0);
  assert.equal(first.status, 'completed');
  assert.throws(() => writeArtifactManifest(cwd, job.id, ['missing.txt'], { status: 'completed' }), /missing/);
  assert.throws(() => assertPreviousStage(cwd, first.stageResult), /missing/);
});

test('stage requirements reject forged status-only and tampered delivery evidence', () => {
  const { cwd, job } = fixture();
  fs.mkdirSync(path.join(cwd, 'artifacts', 'status-only'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'artifacts', 'status-only', 'delivery.json'), JSON.stringify({ status: 'completed' }));
  assert.throws(() => assertPreviousStage(cwd, 'artifacts/status-only/delivery.json'), /acceptance evidence/);
  job.acceptance.stage = 'inspect';
  job.acceptance.expectedChange = true;
  const result = verifyDelivery(job, true, 0);
  assert.equal(result.status, 'incomplete');
  const report = JSON.parse(fs.readFileSync(path.join(cwd, result.stageResult), 'utf8'));
  report.status = 'completed';
  report.taskCompleted = true;
  report.acceptancePassed = true;
  report.deliveryError = null;
  fs.writeFileSync(path.join(cwd, result.stageResult), JSON.stringify(report));
  assert.throws(() => assertPreviousStage(cwd, result.stageResult, 'implement'), /delivery hash is invalid/);
});

test('stage requirements bind a Codex approval to the verified source hashes', () => {
  const { cwd, job } = fixture();
  const result = verifyDelivery(job, true, 0);
  assert.equal(result.status, 'completed');
  assert.throws(() => assertPreviousStage(cwd, result.stageResult), /review attestation/);
  writeReviewAttestation(cwd, result.stageResult, { decision: 'approved', summary: 'Diff and evidence reviewed.' });
  assert.doesNotThrow(() => assertPreviousStage(cwd, result.stageResult));
  const reviewPath = path.join(cwd, path.dirname(result.stageResult), 'codex-review.json');
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.diffHash = 'stale';
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  assert.throws(() => assertPreviousStage(cwd, result.stageResult), /invalid or stale/);
});

test('supervisor records a review only while verified workspace evidence is current', () => {
  const { cwd, job } = fixture();
  Object.assign(job, verifyDelivery(job, true, 0));
  const runtime = new GrokSupervisor();
  runtime.persist = () => {};
  runtime.workers.set(job.id, { job, events: new JobEvents(), policy: { metrics: {} } });
  const reviewed = runtime.recordReview(cwd, job.id, { decision: 'approved', summary: 'Reviewed full diff and evidence.' });
  assert.equal(reviewed.reviewStatus, 'approved');
  assert.equal(reviewed.reviewedDiffHash, job.diffHash);
  assert.ok(fs.existsSync(path.join(cwd, reviewed.reviewFile)));
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'changed after review\n');
  assert.throws(() => runtime.recordReview(cwd, job.id, { decision: 'approved', summary: 'Stale approval.' }), /REVIEW_STALE/);
});

test('verification retry ignores unchanged plugin reports but detects tampering', () => {
  const { cwd, job } = fixture();
  job.acceptance.allowedPaths = ['source.txt'];
  const first = verifyDelivery(job, true, 0);
  assert.equal(first.status, 'completed');
  const retryJob = { ...job, generatedArtifactSnapshot: first.generatedArtifactSnapshot };
  const second = verifyDelivery(retryJob, true, 0);
  assert.equal(second.status, 'completed', second.acceptanceFailures.join('; '));
  fs.writeFileSync(path.join(cwd, second.stageResult), '{"status":"completed","forged":true}');
  const third = verifyDelivery({ ...job, generatedArtifactSnapshot: second.generatedArtifactSnapshot }, true, 0);
  assert.equal(third.status, 'incomplete');
  assert.ok(third.acceptanceFailures.some(message => message.includes('Unexpected changed path')));
});

test('stage preflight fails before probing or executing commands', () => {
  const { cwd } = fixture();
  fs.writeFileSync(path.join(cwd, 'previous.json'), JSON.stringify({ status: 'failed' }));
  assert.throws(() => preflightExecution(cwd, { requires: 'previous.json', requiredCommands: ['does-not-exist'] }, {}, { entry: 'missing-verifier' }), /Previous stage is not successful/);
});

test('artifact and stage symlinks cannot escape the workspace', () => {
  const { cwd } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-integrity-'));
  fs.writeFileSync(path.join(outside, 'delivery.json'), '{"status":"completed"}');
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPreviousStage(cwd, 'linked/delivery.json'), /escapes/);
  assert.throws(() => writeArtifactManifest(cwd, 'copy', ['linked/delivery.json'], {}), /escapes/);
  fs.symlinkSync(outside, path.join(cwd, 'artifacts', 'linked-job'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeArtifactManifest(cwd, 'linked-job', [], {}), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'delivery.json'), 'utf8'), '{"status":"completed"}');
});

test('unknown and infrastructure clusters are not counted as product defects', () => {
  const summary = summarizeTests([
    { command: 'a', exitCode: 1, failureType: 'product', stderr: 'AssertionError: balance' },
    { command: 'b', exitCode: 1, failureType: 'product', stderr: 'AssertionError: balance' },
    { command: 'c', exitCode: 1, failureType: 'test_harness', stderr: 'ReferenceError: fixture' },
    { command: 'd', exitCode: 1, failureType: 'environment', stderr: 'ECONNREFUSED' },
    { command: 'e', exitCode: 1, failureType: 'unknown' }
  ]);
  assert.equal(summary.failed, 5);
  assert.equal(summary.independentDefects, 1);
  assert.equal(summary.failureClusters, 4);
  assert.equal(summary.countUnit, 'command');
});

test('committed oracle changes retain a reviewable baseline diff', () => {
  const { cwd, job } = fixture();
  job.acceptance.frozenTestGlobs = ['source.txt'];
  gitEvidence(cwd, ['add', '.']);
  gitEvidence(cwd, ['commit', '-m', 'changed oracle']);
  const result = verifyDelivery(job, true, 0);
  assert.equal(result.status, 'incomplete');
  assert.match(result.oracleChanged[0].diff, /-before/);
  assert.match(result.oracleChanged[0].diff, /\+after/);
  assert.equal(result.oracleChanged[0].diffBase, job.initialSnapshot.head);
});

test('real verification subprocess streams command progress before completion', async () => {
  const { job } = fixture();
  job.acceptance.requiredCommands = ['node --version', 'node --version'];
  const runtime = new GrokSupervisor();
  runtime.persist = () => {};
  const worker = { job, events: new JobEvents(), policy: new JobPolicy(job) };
  let starts = 0;
  worker.events.on('event', event => {
    if (event.type === 'verification-command-started') {
      starts++;
      assert.equal(worker.policy.currentAction().action, 'node --version');
      assert.equal(worker.policy.heartbeatEvent().progress.total, 2);
    }
  });
  const result = await runtime.verify(worker, true, 0);
  assert.equal(result.status, 'completed');
  assert.equal(starts, 2);
  const finishes = worker.events.entries.filter(e => e.type === 'verification-command-finished');
  assert.deepEqual(finishes.map(e => e.progress.completed), [1, 2]);
  assert.equal(worker.policy.verificationAction, null);
});

test('cleanup without ownership proof retains resource', () => {
  // Missing executable/invalid id cannot authorize a removal.
  const result = executeCleanup({ containers: ['grok-safe-nonexistent-test-resource'] });
  assert.deepEqual(result.cleaned, []);
  assert.equal(result.errors[0].code, 'RESOURCE_OWNERSHIP_UNVERIFIED');
});

test('cleanup deletes only new resources with this job ownership label', () => {
  const calls = [];
  const run = (binary, args) => {
    calls.push(args);
    if (args.includes('inspect')) {
      const id = args.at(-1);
      return { status: 0, stdout: JSON.stringify([{ Config: { Labels: { 'io.grok-safe.job-id': id === 'ours' ? 'job-1' : 'other-job' } } }]) };
    }
    return { status: 0 };
  };
  const result = executeCleanup({ containers: ['ours', 'theirs'] }, 'job-1', run);
  assert.deepEqual(result.cleaned, [{ kind: 'container', id: 'ours' }]);
  assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', 'ours']]);
  assert.equal(result.errors[0].id, 'theirs');
});
