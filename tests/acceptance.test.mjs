import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { normalizeAcceptance, snapshotWorkspace, verifyDelivery, gitEvidence } from "../plugins/grok-safe/scripts/lib/acceptance.mjs";
import { prepareExecutionWorkspace, cleanupExecutionWorkspace } from "../plugins/grok-safe/scripts/lib/execution-workspace.mjs";
import { normalizeControlOptions } from "../plugins/grok-safe/scripts/lib/control.mjs";
import { fileURLToPath } from "node:url";
import { resolveJobsDir, writeJobFile, upsertJob } from "../plugins/grok-safe/scripts/lib/jobs.mjs";

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
  gitEvidence(cwd, ["init"]);
  gitEvidence(cwd, ["config", "user.name", "Test"]);
  gitEvidence(cwd, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "source.txt"), "before\n");
  gitEvidence(cwd, ["add", "."]);
  gitEvidence(cwd, ["commit", "-m", "base"]);
  return cwd;
}
function job(cwd, acceptance = {}) {
  return { workspaceRoot: cwd, executionPath: cwd, write: true, check: true,
    initialSnapshot: snapshotWorkspace(cwd), acceptance: { expectedChange: true, ...acceptance } };
}

test("normal exit and existing dirt cannot masquerade as a delivery", () => {
  const cwd = repo();
  fs.writeFileSync(path.join(cwd, "source.txt"), "pre-existing dirty file\n");
  const j = job(cwd);
  const r = verifyDelivery(j, true, 0);
  assert.equal(r.status, "incomplete");
  assert.equal(r.processExited, true);
  assert.equal(r.taskCompleted, false);
  assert.equal(r.progress.phase, r.status);
});

test("tracked modification passes; requested missing commit fails", () => {
  const cwd = repo(), j = job(cwd);
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  assert.equal(verifyDelivery(j, true, 0).status, "completed");
  j.acceptance.requireCommit = true;
  assert.equal(verifyDelivery(j, true, 0).status, "incomplete");
  gitEvidence(cwd, ["add", "."]);
  gitEvidence(cwd, ["commit", "-m", "result"]);
  const r = verifyDelivery(j, true, 0);
  assert.equal(r.acceptancePassed, true);
  assert.equal(r.baseIsAncestor, true);
  assert.ok(r.resultCommit);
});

test("runner verification records real failures and output", () => {
  const cwd = repo();
  const j = job(cwd, { requireTests: true, requiredCommands: ['node -e "console.error(123);process.exit(7)"'] });
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  const r = verifyDelivery(j, true, 0);
  assert.equal(r.status, "incomplete");
  assert.equal(r.tests[0].exitCode, 7);
  assert.match(r.tests[0].stderr, /123/);
  assert.ok(r.tests[0].startedAt);
});

test("unexpected untracked and forbidden paths fail acceptance", () => {
  const cwd = repo(), j = job(cwd);
  fs.writeFileSync(path.join(cwd, "extra.txt"), "new\n");
  assert.equal(verifyDelivery(j, true, 0).status, "incomplete");
  j.acceptance.allowedPaths = ["*.txt"];
  assert.equal(verifyDelivery(j, true, 0).status, "completed");
  j.acceptance.forbiddenPaths = ["extra.txt"];
  assert.equal(verifyDelivery(j, true, 0).status, "incomplete");
});

test("capability preflight rejects missing command, permissions and shell syntax", () => {
  const control = normalizeControlOptions({});
  assert.throws(() => normalizeAcceptance({ requireTests: true }, control), /requiredCommands/);
  assert.throws(() => normalizeAcceptance({ requireCommit: true }, control), /CAPABILITY_MISSING/);
  assert.throws(() => normalizeAcceptance({ requiredCommands: ["pytest; echo done"] }, control), /shell operators/);
  assert.doesNotThrow(() => normalizeAcceptance({ requiredCommands: ["pytest -q"] }, control));
});

test("explicit existing workspace and resume preserve dirty work and baseline", () => {
  const cwd = repo();
  const original = prepareExecutionWorkspace({ cwd, write: true, worktree: false });
  assert.equal(original.executionPath, cwd);
  assert.equal(original.workspaceMode, "existing-worktree");
  fs.writeFileSync(path.join(cwd, "source.txt"), "in progress\n");
  const resumed = prepareExecutionWorkspace({ cwd, previous: { ...original, grokSessionId: "session" } });
  assert.equal(resumed.baseCommit, original.baseCommit);
  assert.equal(resumed.executionPath, cwd);
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "in progress\n");
  assert.throws(() => prepareExecutionWorkspace({ cwd, previous: {} }), /RESUME_CONTEXT_LOST/);
});

test("managed worktree is plugin-owned and isolated from source directory", () => {
  const cwd = repo(), jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-"));
  const w = prepareExecutionWorkspace({ cwd, jobId: "test", jobsDir, write: true, worktree: true });
  assert.notEqual(w.executionPath, cwd);
  fs.writeFileSync(path.join(w.executionPath, "source.txt"), "isolated\n");
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "before\n");
});

test("cleanup refuses dirty and retained worktrees and removes only a clean owned worktree", () => {
  const cwd = repo(), jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
  const w = prepareExecutionWorkspace({ cwd, jobId: "test", jobsDir, write: true, worktree: true });
  const j = { ...w, id: "test", workspaceRoot: cwd, status: "failed" };
  assert.throws(() => cleanupExecutionWorkspace({ ...j, retained: true }, jobsDir), /retained/);
  fs.writeFileSync(path.join(w.executionPath, "source.txt"), "changed\n");
  assert.throws(() => cleanupExecutionWorkspace(j, jobsDir), /uncommitted/);
  gitEvidence(w.executionPath, ["restore", "source.txt"]);
  assert.equal(cleanupExecutionWorkspace(j, jobsDir).cleaned, true);
  assert.equal(fs.existsSync(w.executionPath), false);
});

test("required artifacts must exist, be fresh and nonempty", () => {
  const cwd = repo();
  const j = job(cwd, { requiredArtifacts: ["report.txt"], allowedPaths: ["*.txt"] });
  j.initialSnapshot = snapshotWorkspace(cwd, ["report.txt"]);
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  assert.equal(verifyDelivery(j, true, 0).status, "incomplete");
  fs.writeFileSync(path.join(cwd, "report.txt"), "verified result\n");
  assert.equal(verifyDelivery(j, true, 0).status, "completed");
});

test("background result reconciliation cannot accept a plan-only write task", () => {
  const cwd = repo();
  const prior = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-state-"));
  try {
    const j = { ...job(cwd), id: "task-no-delivery", kind: "task", status: "running", config: {}, createdAt: new Date().toISOString() };
    const jobsDir = resolveJobsDir(cwd);
    fs.mkdirSync(jobsDir, { recursive: true });
    j.resultFile = path.join(jobsDir, `${j.id}.result.json`);
    j.progressFile = path.join(jobsDir, `${j.id}.progress.json`);
    fs.writeFileSync(j.resultFile, JSON.stringify({ exitCode: 0, stdout: JSON.stringify({ text: "I will edit the file next", sessionId: "session", stopReason: "EndTurn" }) }));
    writeJobFile(cwd, j); upsertJob(cwd, j);
    const companion = fileURLToPath(new URL("../plugins/grok-safe/scripts/grok-companion.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [companion, "result", j.id, "--json"], { cwd, encoding: "utf8", env: process.env });
    assert.equal(r.status, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, "incomplete");
    assert.equal(result.error.code, "ACCEPTANCE_FAILED");
    assert.equal(result.progress.phase, "incomplete");
    assert.equal(result.initialSnapshot, undefined);
  } finally {
    if (prior === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE;
    else process.env.GROK_CODEX_PLUGIN_STATE = prior;
  }
});
