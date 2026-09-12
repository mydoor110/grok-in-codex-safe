import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionsCliOutput } from "../plugins/grok-safe/scripts/lib/sessions.mjs";

test("parseSessionsCliOutput reads uuid lines", () => {
  const text = `
019fca4c-c567-79c2-8f59-092e326cc2f4 My session title
not-a-session
{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","title":"JSON one"}
`.trim();
  const sessions = parseSessionsCliOutput(text);
  assert.ok(sessions.some((s) => s.id.startsWith("019fca4c")));
  assert.ok(sessions.some((s) => s.id.startsWith("aaaaaaaa")));
  const first = sessions.find((s) => s.id.startsWith("019fca4c"));
  assert.match(first.title || "", /My session/);
});
