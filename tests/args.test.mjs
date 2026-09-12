import assert from "node:assert/strict";
import test from "node:test";

import { expandArgv, parseArgs, splitRawArgumentString } from "../plugins/grok-safe/scripts/lib/args.mjs";

test("expandArgv always splits a single shell-word blob (flagless multi-word)", () => {
  // Claude Code slash commands pass "$ARGUMENTS" as one argv entry without requiring "--"
  assert.deepEqual(expandArgv(["workflow run implement-landing"]), [
    "workflow",
    "run",
    "implement-landing"
  ]);
  assert.deepEqual(expandArgv(["babysit add 123 456"]), ["babysit", "add", "123", "456"]);
  assert.deepEqual(expandArgv(["sessions search retry layer"]), [
    "sessions",
    "search",
    "retry",
    "layer"
  ]);
  assert.deepEqual(expandArgv(["sessions export abc-123 --json"]), [
    "sessions",
    "export",
    "abc-123",
    "--json"
  ]);
});

test("expandArgv leaves already-split argv alone", () => {
  assert.deepEqual(expandArgv(["workflow", "run", "name"]), ["workflow", "run", "name"]);
});

test("parseArgs handles booleans and values", () => {
  const { options, positionals } = parseArgs(
    ["--background", "--model", "fast", "--effort=high", "fix the bug"],
    {
      booleanOptions: ["background"],
      valueOptions: ["model", "effort"]
    }
  );

  assert.equal(options.background, true);
  assert.equal(options.model, "fast");
  assert.equal(options.effort, "high");
  assert.deepEqual(positionals, ["fix the bug"]);
});

test("splitRawArgumentString respects quotes", () => {
  const tokens = splitRawArgumentString(`--model fast "fix the 'quoted' bug"`);
  assert.deepEqual(tokens, ["--model", "fast", "fix the 'quoted' bug"]);
});
