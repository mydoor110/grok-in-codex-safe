import assert from "node:assert/strict";
import test from "node:test";

import {
  babysitSupportsBackground,
  buildBabysitPrompt,
  parseBabysitInvocation
} from "../plugins/grok-safe/scripts/lib/babysit.mjs";

test("parseBabysitInvocation parses add with prs", () => {
  const r = parseBabysitInvocation(["add", "12", "#34"]);
  assert.equal(r.action, "add");
  assert.deepEqual(r.prs, [12, 34]);
});

test("parseBabysitInvocation rejects bad action", () => {
  assert.throws(() => parseBabysitInvocation(["dance"]), /Unknown babysit action/);
});

test("parseBabysitInvocation requires prs for add/remove", () => {
  assert.throws(() => parseBabysitInvocation(["add"]), /PR number/);
  assert.throws(() => parseBabysitInvocation(["remove"]), /PR number/);
});

test("buildBabysitPrompt for check", () => {
  const p = buildBabysitPrompt("check", []);
  assert.match(p, /pr-babysit/);
  assert.match(p, /check/);
  assert.match(p, /Never merge/i);
});

test("babysitSupportsBackground", () => {
  assert.equal(babysitSupportsBackground("check"), true);
  assert.equal(babysitSupportsBackground("list"), false);
});
