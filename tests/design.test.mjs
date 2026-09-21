import assert from "node:assert/strict";
import test from "node:test";

import { buildDesignPrompt, buildExecutePlanPrompt } from "../plugins/grok-safe/scripts/lib/design.mjs";

test("buildDesignPrompt requires brief", () => {
  assert.throws(() => buildDesignPrompt(""), /required/i);
});

test("buildDesignPrompt invokes design skill loop", () => {
  const p = buildDesignPrompt("multi-tenant billing");
  assert.match(p, /design skill/i);
  assert.match(p, /multi-tenant billing/);
  assert.match(p, /DESIGN_DOC_PATH/);
  assert.match(p, /PR Plan/);
  assert.match(p, /spawn_subagent|writer|reviewer/i);
  assert.match(p, /subagents are disabled/i);
  assert.match(buildDesignPrompt("x", { allowSubagents: true, agentBudget: 2 }), /maximum 2 active agents/i);
});

test("buildExecutePlanPrompt requires doc or resume", () => {
  assert.throws(() => buildExecutePlanPrompt(""), /required/i);
});

test("buildExecutePlanPrompt includes flags", () => {
  const p = buildExecutePlanPrompt("/tmp/design.md", {
    concurrency: 2,
    dryRun: true,
    autoPr: true,
    noGraphite: true
  });
  assert.match(p, /execute-plan/);
  assert.match(p, /\/tmp\/design\.md/);
  assert.match(p, /--dry-run/);
  assert.match(p, /--auto-pr/);
  assert.match(p, /--no-graphite/);
  assert.match(p, /--concurrency 2/);
  assert.match(p, /sequentially because subagents are disabled/i);
});
