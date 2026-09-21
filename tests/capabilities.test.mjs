import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commandCapability, isMutableTag, mutatesProduction
} from "../plugins/grok-safe/scripts/lib/capabilities.mjs";
import { classifyFailureType, gitEvidence, normalizeAcceptance, snapshotWorkspace, verifyDelivery } from "../plugins/grok-safe/scripts/lib/acceptance.mjs";
import { JobPolicy } from "../plugins/grok-safe/scripts/lib/job-policy.mjs";
import { JobEvents, supervisionEvent } from "../plugins/grok-safe/scripts/lib/events.mjs";
import { normalizeControlOptions } from "../plugins/grok-safe/scripts/lib/control.mjs";
import { writeWatchShouldStall } from "../plugins/grok-safe/scripts/lib/watchdog.mjs";
import { canonicalizeSeverity, tryParseStructuredReview } from "../plugins/grok-safe/scripts/lib/review.mjs";

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "capabilities-"));
  gitEvidence(cwd, ["init"]);
  gitEvidence(cwd, ["config", "user.name", "Test"]);
  gitEvidence(cwd, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "source.txt"), "before\n");
  fs.writeFileSync(path.join(cwd, "test.mjs"), "assert(true)\n");
  gitEvidence(cwd, ["add", "."]);
  gitEvidence(cwd, ["commit", "-m", "base"]);
  return cwd;
}

test("default capabilities are verify-only and docker push stays denied", () => {
  const control = normalizeControlOptions({});
  const acceptance = normalizeAcceptance({}, control);
  assert.deepEqual(acceptance.capabilities, ["read", "edit", "test"]);
  assert.equal(mutatesProduction(acceptance.capabilities), false);
  assert.ok(control.deny.includes("Bash(docker*)"));
  assert.equal(commandCapability("docker push repo:tag"), "push");
  assert.equal(commandCapability("docker compose up"), "buildImage");
});

test("buildImage allows compose and still blocks push", () => {
  const cwd = repo();
  const control = normalizeControlOptions({});
  const acceptance = normalizeAcceptance({ capabilities: ["read", "edit", "test", "buildImage"] }, control);
  assert.ok(control.allow.some(rule => rule.startsWith("Bash(docker compose")));
  assert.ok(control.deny.includes("Bash(docker push*)"));
  const events = [];
  const policy = new JobPolicy({ executionPath: cwd, write: true, acceptance, control }, (type, data) => events.push({ type, ...data }));
  assert.equal(policy.before({ toolName: "bash", toolInput: { command: "docker compose ps" } }).decision, "allow");
  assert.equal(policy.phase, "packaging");
  assert.throws(() => policy.before({ toolName: "bash", toolInput: { command: "docker push repo:tag" } }), /outside permitted/);
});

test("push requires sensitive approval, image preview and an immutable tag", () => {
  const control = normalizeControlOptions({});
  assert.throws(() => normalizeAcceptance({ capabilities: ["read", "push"] }, control), /sensitiveApproved/);
  control.sensitiveApproved = true;
  assert.throws(() => normalizeAcceptance({ capabilities: ["read", "push"] }, control), /publish.images/);
  assert.throws(() => normalizeAcceptance({
    capabilities: ["read", "push"],
    publish: { images: [{ repository: "ex/backend", tag: "latest" }] }
  }, control), /mutable/);
  const acceptance = normalizeAcceptance({
    capabilities: ["read", "edit", "test", "push"],
    publish: { images: [{ repository: "ex/backend", tag: "latest", immutableTag: "backend-20260915-deadbee" }] }
  }, control);
  assert.equal(mutatesProduction(acceptance.capabilities), true);
  assert.equal(isMutableTag("latest"), true);
  assert.equal(isMutableTag("backend-20260915-deadbee"), false);
});

test("frozen test globs fail acceptance when oracles change", () => {
  const cwd = repo();
  const j = {
    workspaceRoot: cwd, executionPath: cwd, write: true, check: true,
    initialSnapshot: snapshotWorkspace(cwd),
    acceptance: { expectedChange: true, allowedPaths: ["source.txt", "test.mjs"], frozenTestGlobs: ["test.mjs"] }
  };
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  assert.equal(verifyDelivery(j, true, 0).status, "completed");
  fs.writeFileSync(path.join(cwd, "test.mjs"), "assert(false)\n");
  const failed = verifyDelivery(j, true, 0);
  assert.equal(failed.status, "incomplete");
  assert.equal(failed.oracleChanged[0].path, "test.mjs");
  assert.equal(failed.oracleChanged[0].reason, null);
  assert.ok(failed.remainingRisks.some(item => item.type === "oracle-changed"));
});

test("dirty publish is rejected unless allowDirtyPublish is set", () => {
  const cwd = repo();
  const control = normalizeControlOptions({ sensitiveApproved: true });
  const acceptance = normalizeAcceptance({
    expectedChange: true,
    allowedPaths: ["source.txt"],
    capabilities: ["read", "edit", "test", "push"],
    publish: { images: [{ repository: "ex/backend", tag: "latest", immutableTag: "backend-20260915-deadbee" }] }
  }, control);
  const initialSnapshot = snapshotWorkspace(cwd);
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  const j = { workspaceRoot: cwd, executionPath: cwd, write: true, check: true, sourceDirty: true, initialSnapshot, acceptance };
  const blocked = verifyDelivery(j, true, 0);
  assert.equal(blocked.status, "incomplete");
  assert.ok(blocked.acceptanceFailures.some(item => /Dirty worktree/.test(item)));
  acceptance.publish.allowDirtyPublish = true;
  const allowed = verifyDelivery(j, true, 0);
  assert.equal(allowed.status, "completed");
  assert.equal(allowed.productionChanged, false);
  assert.equal(allowed.images[0].immutableTag, "backend-20260915-deadbee");
  assert.ok(allowed.remainingRisks.some(item => item.type === "dirty-publish"));
});

test("failure types distinguish harness, environment and product", () => {
  assert.equal(classifyFailureType("assertion-failure", "ReferenceError: foo is not defined"), "test_harness");
  assert.equal(classifyFailureType("timeout", ""), "environment");
  assert.equal(classifyFailureType("dependency-missing", "Cannot find module"), "infrastructure");
  assert.equal(classifyFailureType("assertion-failure", "AssertionError: expected 2"), "product");
  const cwd = repo();
  const j = {
    workspaceRoot: cwd, executionPath: cwd, write: true, check: true,
    initialSnapshot: snapshotWorkspace(cwd),
    acceptance: { expectedChange: true, requireTests: true, requiredCommands: ['node -e "console.error(123);process.exit(7)"'] }
  };
  fs.writeFileSync(path.join(cwd, "source.txt"), "after\n");
  const r = verifyDelivery(j, true, 0);
  assert.equal(r.tests[0].failureType, "unknown");
  assert.equal(r.testSummary.failed, 1);
  assert.equal(r.testSummary.unknownFailures, 1);
  assert.equal(r.testSummary.independentDefects, 0);
  assert.equal(r.testSummary.failureClusters, 1);
});

test("idle stall skips active tools and routine heartbeats do not wake compact wait", async () => {
  const cwd = repo();
  const events = [];
  const policy = new JobPolicy(
    { executionPath: cwd, write: true, acceptance: {}, control: normalizeControlOptions({}), runtime: { heartbeatSeconds: 1, idleSeconds: 1 } },
    (type, data) => events.push({ type, ...data })
  );
  policy.lastHeartbeat = 0;
  assert.equal(policy.checkTime(), null);
  assert.equal(events.some(event => event.type === "heartbeat"), true);
  policy.lastActivity = Date.now() - 4000;
  assert.equal(policy.checkTime()?.code, "STALLED");
  policy.before({ toolName: "bash", toolInput: { command: "npm test" } });
  policy.lastActivity = Date.now() - 4000;
  policy.lastHeartbeat = 0;
  assert.equal(policy.checkTime(), null);
  assert.equal(writeWatchShouldStall(0, 200000, 0), true);
  assert.equal(writeWatchShouldStall(0, 200000, 1), false);
  const log = new JobEvents();
  let settled = false;
  const wait = log.wait(0, 1000, undefined, true).then(value => { settled = true; return value; });
  log.publish("heartbeat", { phase: "verifying", currentAction: "npm test" });
  await Promise.resolve();
  assert.equal(settled, false);
  log.publish("heartbeat", { phase: "verifying", currentAction: "still running" });
  log.publish("heartbeat", { phase: "verifying", currentAction: "still running 2" });
  log.publish("stall-warning", { phase: "verifying" });
  assert.equal((await wait).events[0].type, "stall-warning");
  assert.equal(log.since(0, true).events.filter(event => event.type === "heartbeat").length, 0);
  assert.equal(supervisionEvent({ type: "heartbeat" }), false);
});

test("P0 without outage evidence is stored as high", () => {
  const adjusted = canonicalizeSeverity("p0", { body: "API returned 500 but did not double-charge" });
  assert.equal(adjusted.severity, "high");
  assert.equal(adjusted.severityAdjusted, true);
  const review = tryParseStructuredReview(JSON.stringify({
    verdict: "request_changes",
    summary: "One finding",
    findings: [{ severity: "p0", title: "500", body: "API returned 500 but did not double-charge", file: "a.ts" }],
    next_steps: ["Check retries"]
  }));
  assert.equal(review.findings[0].severity, "high");
  assert.equal(review.findings[0].reportedSeverity, "p0");
  assert.equal(review.findings[0].severityAdjusted, true);
});
