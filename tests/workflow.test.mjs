import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkflowPrompt,
  discoverWorkflows,
  parseWorkflowArgs,
  tryParseWorkflowMeta
} from "../plugins/grok-safe/scripts/lib/workflow.mjs";

test("buildWorkflowPrompt requires name", () => {
  assert.throws(() => buildWorkflowPrompt({ name: "" }), /required/i);
});

test("buildWorkflowPrompt mentions workflow tool and args", () => {
  const p = buildWorkflowPrompt({ name: "review-changes", args: { target: "main" } });
  assert.match(p, /review-changes/);
  assert.match(p, /workflow tool/i);
  assert.match(p, /"target":"main"/);
});

test("buildWorkflowPrompt validateOnly uses validate_only", () => {
  const p = buildWorkflowPrompt({ name: "x", validateOnly: true });
  assert.match(p, /validate_only/i);
});

test("parseWorkflowArgs parses key=value and JSON-ish", () => {
  const args = parseWorkflowArgs(["target=main", "n=3", "flag", "nested={\"a\":1}"]);
  assert.equal(args.target, "main");
  assert.equal(args.n, 3);
  assert.equal(args.flag, true);
  assert.deepEqual(args.nested, { a: 1 });
});

test("discoverWorkflows finds project rhai files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wf-"));
  const dir = path.join(tmp, ".grok", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "review-changes.rhai");
  fs.writeFileSync(
    file,
    `let meta = #{\n    name: "review-changes",\n    description: "Review a diff",\n};\n`,
    "utf8"
  );
  const found = discoverWorkflows(tmp);
  assert.ok(found.some((w) => w.name === "review-changes"));
  const hit = found.find((w) => w.name === "review-changes");
  assert.equal(hit.scope, "project");
  assert.match(hit.description || "", /Review/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("tryParseWorkflowMeta reads name and description", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wf-meta-"));
  const file = path.join(tmp, "x.rhai");
  fs.writeFileSync(file, 'let meta = #{ name: "my-wf", description: "hello world" };\n');
  const meta = tryParseWorkflowMeta(file);
  assert.equal(meta.name, "my-wf");
  assert.equal(meta.description, "hello world");
  fs.rmSync(tmp, { recursive: true, force: true });
});
