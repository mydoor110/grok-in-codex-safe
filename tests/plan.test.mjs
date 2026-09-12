import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanModePrompt } from "../plugins/grok-safe/scripts/lib/design.mjs";

test("buildPlanModePrompt requires brief", () => {
  assert.throws(() => buildPlanModePrompt(""), /required/i);
});

test("buildPlanModePrompt includes exploration and plan.md guidance", () => {
  const p = buildPlanModePrompt("add caching to the API");
  assert.match(p, /plan mode/i);
  assert.match(p, /plan\.md/);
  assert.match(p, /add caching to the API/);
  assert.match(p, /verification/i);
  assert.match(p, /Do not implement/i);
});
