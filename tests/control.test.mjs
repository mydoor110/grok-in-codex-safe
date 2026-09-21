import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_ARRAY_OPTIONS,
  applyControlToGrokOptions,
  compareSemver,
  controlFromParsedOptions,
  controlToGrokFields,
  controlToJobConfig,
  normalizeControlOptions
} from "../plugins/grok-safe/scripts/lib/control.mjs";
import { buildGrokArgs } from "../plugins/grok-safe/scripts/lib/grok.mjs";
import { normalizeRuntime } from "../plugins/grok-safe/scripts/lib/job-policy.mjs";
import { parseArgs } from "../plugins/grok-safe/scripts/lib/args.mjs";

test("normalizeControlOptions maps sandbox aliases", () => {
  const c = normalizeControlOptions({ sandbox: "ro" });
  assert.equal(c.sandbox, "read-only");
});

test("normalizeControlOptions rejects unknown sandbox", () => {
  assert.throws(() => normalizeControlOptions({ sandbox: "banana" }), /sandbox/);
});

test("controlToGrokFields emits plan permission mode", () => {
  const fields = controlToGrokFields(normalizeControlOptions({ planMode: true, sandbox: "workspace" }));
  assert.equal(fields.permissionMode, "plan");
  assert.equal(fields.sandbox, "workspace");
});

test("memory true/false/null map correctly", () => {
  assert.deepEqual(controlToGrokFields(normalizeControlOptions({ memory: true })).memory, {
    enable: true
  });
  assert.deepEqual(controlToGrokFields(normalizeControlOptions({ memory: false })).memory, {
    enable: false
  });
  assert.deepEqual(controlToGrokFields(normalizeControlOptions({})).memory, { enable: false });
});

test("controlFromParsedOptions handles --memory and --no-memory", () => {
  assert.equal(controlFromParsedOptions({ memory: true }).memory, true);
  assert.equal(controlFromParsedOptions({ "no-memory": true }).memory, false);
});

test("secure defaults auto-approve only explicit project-safe capabilities", () => {
  const control = normalizeControlOptions({});
  assert.equal(control.sandbox, "workspace");
  assert.equal(control.permissionMode, "dontAsk");
  assert.equal(control.noSubagents, true);
  assert.equal(control.disableWebSearch, true);
  assert.ok(control.allow.includes("Edit"));
  assert.ok(control.allow.includes("Bash(npm test*)"));
  assert.ok(control.deny.includes("Bash(git push*)"));
});

test("subagents require an explicit opt-in", () => {
  assert.equal(normalizeControlOptions({}).noSubagents, true);
  assert.equal(normalizeControlOptions({ subagents: true }).noSubagents, false);
  assert.equal(controlFromParsedOptions({ subagents: true }).noSubagents, false);
});

test("secure defaults reject bypass-permissions and disabled sandbox", () => {
  assert.throws(
    () => normalizeControlOptions({ permissionMode: "bypassPermissions" }),
    /forbids/
  );
  assert.throws(() => normalizeControlOptions({ sandbox: "off" }), /requires/);
});

test("buildGrokArgs emits control surface flags", () => {
  const control = normalizeControlOptions({
    sandbox: "workspace",
    planMode: true,
    memory: true,
    noSubagents: true,
    agent: "explore",
    allow: ["Bash(npm*)"],
    deny: ["Bash(rm*)"],
    disableWebSearch: true,
    forkSession: true,
    maxTurns: 3
  });
  const args = buildGrokArgs(
    applyControlToGrokOptions({ prompt: "hi", write: true }, control)
  );
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace"));
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("plan"));
  assert.ok(args.includes("--experimental-memory"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--agent"));
  assert.ok(args.includes("explore"));
  assert.ok(args.includes("--allow"));
  assert.ok(args.includes("Bash(npm*)"));
  assert.ok(args.includes("--deny"));
  assert.ok(args.includes("Bash(rm*)"));
  assert.ok(args.includes("--disable-web-search"));
  assert.ok(args.includes("--fork-session"));
  assert.ok(args.includes("--max-turns"));
  assert.ok(args.includes("3"));
  // plan mode must not yolo
  assert.ok(!args.includes("--yolo"));
});

test("buildGrokArgs memory off uses --no-memory", () => {
  const control = normalizeControlOptions({ memory: false });
  const args = buildGrokArgs(applyControlToGrokOptions({ prompt: "x", write: true }, control));
  assert.ok(args.includes("--no-memory"));
  assert.ok(!args.includes("--experimental-memory"));
});

test("parseArgs accumulates array options for allow/deny", () => {
  const { options } = parseArgs(
    ["--allow", "Bash(npm*)", "--allow", "Bash(git*)", "--deny", "Bash(rm*)"],
    {
      valueOptions: ["allow", "deny"],
      arrayOptions: CONTROL_ARRAY_OPTIONS
    }
  );
  assert.deepEqual(options.allow, ["Bash(npm*)", "Bash(git*)"]);
  assert.deepEqual(options.deny, ["Bash(rm*)"]);
});

test("controlToJobConfig persists schema fields", () => {
  const control = normalizeControlOptions({ sandbox: "strict", planMode: true });
  const config = controlToJobConfig(control, { bestOfN: 3, check: true });
  assert.equal(config.sandbox, "strict");
  assert.equal(config.planMode, true);
  assert.equal(config.bestOfN, 3);
  assert.equal(config.check, true);
});

test("compareSemver works", () => {
  assert.equal(compareSemver("0.2.118", "0.2.118"), 0);
  assert.ok(compareSemver("0.2.117", "0.2.118") < 0);
  assert.ok(compareSemver("0.2.119", "0.2.118") > 0);
  assert.ok(compareSemver("grok 0.2.118 (abc)", "0.2.100") > 0);
});

test("runtime token budgets are optional, bounded, and ordered", () => {
  assert.equal(normalizeRuntime({}).tokenHardLimit, 0);
  assert.equal(normalizeRuntime({ tokenSoftLimit: 1000, tokenHardLimit: 2000 }).tokenSoftLimit, 1000);
  assert.throws(() => normalizeRuntime({ tokenSoftLimit: 3000, tokenHardLimit: 2000 }), /cannot exceed/);
});
