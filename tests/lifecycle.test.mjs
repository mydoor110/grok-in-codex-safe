import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkComposeFiles, composeBindMounts, createdResources, leftoverFromCreated,
  normalizeCleanupPolicy, normalizePreflight, planCleanup, runContractPreflight
} from "../plugins/grok-safe/scripts/lib/preflight.mjs";
import {
  assertPreviousStage, gitEvidence, normalizeAcceptance, snapshotWorkspace, verifyDelivery, writeArtifactManifest, writeReviewAttestation
} from "../plugins/grok-safe/scripts/lib/acceptance.mjs";
import { JobPolicy } from "../plugins/grok-safe/scripts/lib/job-policy.mjs";
import { normalizeControlOptions } from "../plugins/grok-safe/scripts/lib/control.mjs";

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  gitEvidence(cwd, ["init"]);
  gitEvidence(cwd, ["config", "user.name", "Test"]);
  gitEvidence(cwd, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "source.txt"), "before\n");
  fs.writeFileSync(path.join(cwd, "test.mjs"), "assert(true)\n");
  gitEvidence(cwd, ["add", "."]);
  gitEvidence(cwd, ["commit", "-m", "base"]);
  return cwd;
}

test("preflight and cleanup defaults are capability-driven, not project-specific", () => {
  const verify = normalizePreflight(undefined, ["read", "edit", "test"]);
  assert.deepEqual(verify.tools, []);
  assert.equal(verify.diskMb, null);
  const image = normalizePreflight({ tools: ["docker"], env: ["CI"], ports: [8080], composeFiles: ["compose.yaml"] }, ["read", "buildImage"]);
  assert.deepEqual(image.tools, ["docker"]);
  assert.deepEqual(image.env, ["CI"]);
  assert.deepEqual(image.ports, [8080]);
  assert.equal(image.diskMb, 256);
  const cleanup = normalizeCleanupPolicy(undefined, ["buildImage"]);
  assert.equal(cleanup.containers, "always");
  assert.equal(cleanup.volumes, "retain_on_failure");
  assert.equal(cleanup.images, "retain");
  assert.equal(normalizeCleanupPolicy(undefined, ["read"]).containers, "never");
});

test("compose bind mounts are resolved relative to the compose file", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "compose-"));
  fs.writeFileSync(path.join(cwd, "data.txt"), "ok\n");
  fs.writeFileSync(path.join(cwd, "compose.yaml"), "services:\n  app:\n    volumes:\n      - ./missing:/data\n      - ./data.txt:/file\n");
  assert.deepEqual(composeBindMounts(fs.readFileSync(path.join(cwd, "compose.yaml"), "utf8")), ["./missing", "./data.txt"]);
  assert.throws(() => checkComposeFiles(cwd, ["compose.yaml"]), /COMPOSE_MOUNT_MISSING/);
  fs.mkdirSync(path.join(cwd, "missing"));
  assert.equal(checkComposeFiles(cwd, ["compose.yaml"]).length, 1);
});

test("contract preflight checks declared env vars and extra tools", () => {
  const cwd = repo();
  assert.throws(() => runContractPreflight(cwd, { tools: [], env: ["GROK_SAFE_TEST_ENV"], ports: [], composeFiles: [], diskMb: null, registry: false }, []), /ENV_MISSING/);
  const env = { ...process.env, GROK_SAFE_TEST_ENV: "1" };
  const ok = runContractPreflight(cwd, { tools: ["node"], env: ["GROK_SAFE_TEST_ENV"], ports: [], composeFiles: [], diskMb: null, registry: false }, [], env);
  assert.equal(ok.checks.env.GROK_SAFE_TEST_ENV, "set");
  assert.ok(ok.checks.tools.node);
  assert.throws(() => runContractPreflight(cwd, { tools: ["definitely-missing-bin-xyz"], env: [], ports: [], composeFiles: [], diskMb: null, registry: false }, []), /EXECUTABLE_MISSING/);
});

test("occupied ports fail preflight", async () => {
  const server = net.createServer();
  const port = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  try {
    assert.throws(() => runContractPreflight(process.cwd(), { tools: [], env: [], ports: [port], composeFiles: [], diskMb: null, registry: false }, []), /PORT_IN_USE/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("oracle changes require a reason and include a diff", () => {
  const cwd = repo();
  const initialSnapshot = snapshotWorkspace(cwd);
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "test.mjs"), "assert(false)\n");
  const blocked = verifyDelivery({
    workspaceRoot: cwd, executionPath: cwd, write: true, check: true, initialSnapshot,
    acceptance: { expectedChange: true, allowedPaths: ["source.txt", "test.mjs"], frozenTestGlobs: ["test.mjs"] }
  }, true, 0);
  assert.equal(blocked.status, "incomplete");
  assert.match(blocked.oracleChanged[0].diff || "", /assert/);
  const allowed = verifyDelivery({
    workspaceRoot: cwd, executionPath: cwd, write: true, check: true, initialSnapshot,
    acceptance: {
      expectedChange: true, allowedPaths: ["source.txt", "test.mjs"], frozenTestGlobs: ["test.mjs"],
      oracleChangeReasons: { "test.mjs": "fix undefined harness variable" }
    }
  }, true, 0);
  assert.equal(allowed.status, "completed");
  assert.equal(allowed.oracleChanged[0].reason, "fix undefined harness variable");
});

test("delivery artifacts write a SHA-256 manifest under artifacts/<jobId>/", () => {
  const cwd = repo();
  const initialSnapshot = snapshotWorkspace(cwd);
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "report.txt"), "verified\n");
  const delivered = verifyDelivery({
    id: "job-1", workspaceRoot: cwd, executionPath: cwd, write: true, check: true, initialSnapshot,
    acceptance: { expectedChange: true, allowedPaths: ["source.txt", "report.txt"], requiredArtifacts: ["report.txt"], artifactGlobs: ["report.txt"] }
  }, true, 0);
  assert.equal(delivered.status, "completed", delivered.acceptanceFailures?.join("; "));
  assert.equal(delivered.artifacts.dir, "artifacts/job-1");
  assert.ok(delivered.artifacts.manifest.sha256);
  assert.ok(delivered.artifacts.manifest.files.some(file => file.path === "report.txt" && file.sha256));
  assert.ok(fs.existsSync(path.join(cwd, "artifacts", "job-1", "manifest.json")));
  assert.ok(fs.existsSync(path.join(cwd, "artifacts", "job-1", "delivery.json")));
});

test("stage jobs are gated and require a successful previous stage result", () => {
  const cwd = repo();
  const control = normalizeControlOptions({});
  const inspect = normalizeAcceptance({ stage: "inspect" }, control, { write: true });
  assert.equal(inspect.expectedChange, false);
  assert.throws(() => normalizeAcceptance({ stage: "package" }, control), /buildImage/);
  const policy = new JobPolicy({ executionPath: cwd, write: true, acceptance: inspect, control });
  assert.throws(() => policy.before({ toolName: "write", toolInput: { path: "source.txt" } }), /Inspect stage/);
  fs.mkdirSync(path.join(cwd, "artifacts", "prev"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "artifacts", "prev", "delivery.json"), JSON.stringify({ status: "failed" }));
  assert.throws(() => assertPreviousStage(cwd, "artifacts/prev/delivery.json"), /not successful/);
  writeArtifactManifest(cwd, "prev", [], { status: "completed", taskCompleted: true, acceptancePassed: true,
    stage: "inspect", diffHash: "diff", sourceTreeHash: "tree", sourceCommit: "commit", deliveryError: null });
  writeReviewAttestation(cwd, "artifacts/prev/delivery.json", { decision: "approved", summary: "Reviewed the stage evidence." });
  assert.doesNotThrow(() => assertPreviousStage(cwd, "artifacts/prev/delivery.json", "implement"));
  assert.throws(() => assertPreviousStage(cwd, "artifacts/prev/delivery.json", "inspect"), /order is invalid/);
  const implement = normalizeAcceptance({
    stage: "implement", expectedChange: true, capabilities: ["read", "edit", "test", "buildImage"]
  }, control);
  const implementPolicy = new JobPolicy({ executionPath: cwd, write: true, acceptance: implement, control });
  assert.throws(() => implementPolicy.before({ toolName: "bash", toolInput: { command: "docker compose ps" } }), /Implement stage/);
});

test("cleanup planner only touches resources created during the job", () => {
  const before = { containers: ["old"], volumes: ["keep"], networks: ["n1"], images: ["img"] };
  const after = { containers: ["old", "newc"], volumes: ["keep", "newv"], networks: ["n1"], images: ["img", "newi"] };
  const created = createdResources(before, after);
  assert.deepEqual(created.containers, ["newc"]);
  assert.deepEqual(created.volumes, ["newv"]);
  const failed = planCleanup(created, { containers: "always", networks: "always", volumes: "retain_on_failure", images: "retain" }, false);
  assert.deepEqual(failed.containers, ["newc"]);
  assert.deepEqual(failed.volumes, []);
  const ok = planCleanup(created, { containers: "always", networks: "always", volumes: "retain_on_failure", images: "retain" }, true);
  assert.deepEqual(ok.volumes, ["newv"]);
  const leftover = leftoverFromCreated(created, [{ kind: "container", id: "newc" }]);
  assert.ok(leftover.some(item => item.kind === "volume" && item.id === "newv"));
  assert.ok(leftover.some(item => item.kind === "image" && item.retained));
});
