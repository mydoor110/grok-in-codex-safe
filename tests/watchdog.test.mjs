import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createActionWatchdog } from "../plugins/grok-safe/scripts/lib/watchdog.mjs";
import { buildGrokBackgroundWrapperSource } from "../plugins/grok-safe/scripts/lib/grok.mjs";

test("stream chunks never count as turns; explicit narration triggers warning then stall", () => {
  const w = createActionWatchdog();
  for (let i = 0; i < 100; i++) assert.equal(w.observe({ type: "text", data: "plan" }).turns, 0);
  assert.equal(w.observe({ type: "turn_end" }).stalled, false);
  assert.equal(w.observe({ type: "turn_end" }).warning, true);
  assert.equal(w.observe({ type: "turn_end" }).stalled, true);
});

test("a mutation resets narration streak", () => {
  const w = createActionWatchdog();
  w.observe({ type: "turn_end" });
  w.observe({ type: "turn_end" });
  w.observe({ type: "tool_call", name: "Edit" });
  const metrics = w.observe({ type: "turn_end" });
  assert.equal(metrics.stalled, false);
  assert.equal(metrics.mutationTurns, 1);
});

test("real streaming runner persists usage and leaves completion to acceptance", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const resultFile = path.join(cwd, "result.json"), progressFile = path.join(cwd, "progress.json");
  const events = [{ type: "text", data: "done" }, { type: "end", sessionId: "same-session", usage: { total_tokens: 3 }, model: "actual-model" }];
  const script = buildGrokBackgroundWrapperSource({ binary: process.execPath,
    args: ["-e", `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e))`],
    resultFile, progressFile, cwd, streaming: true });
  const r = spawnSync(process.execPath, ["-e", script], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(fs.readFileSync(resultFile));
  assert.equal(JSON.parse(payload.stdout).model, "actual-model");
  assert.equal(JSON.parse(payload.stdout).usage.total_tokens, 3);
  assert.equal(JSON.parse(fs.readFileSync(progressFile)).phase, "verifying");
  assert.equal(payload.metrics.turnEventsObserved, false);
});
