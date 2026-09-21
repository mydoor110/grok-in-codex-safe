import assert from "node:assert/strict";
import test from "node:test";

import {
  extractUsageFromParsed,
  extractUsageFromStdout,
  formatUsageSummary,
  normalizeUsage,
  aggregateUsage
} from "../plugins/grok-safe/scripts/lib/usage.mjs";

test("extractUsageFromParsed reads headless json spend fields", () => {
  const usage = extractUsageFromParsed({
    text: "ok",
    num_turns: 7,
    total_cost_usd: 0.0127,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 10
    },
    modelUsage: { "grok-4.5": { inputTokens: 100 } }
  });
  assert.equal(usage.num_turns, 7);
  assert.equal(usage.total_cost_usd, 0.0127);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.total_tokens, 150);
  assert.ok(usage.modelUsage);
});

test("normalizes and aggregates ACP turn_completed camelCase usage", () => {
  const first = normalizeUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
    cachedReadTokens: 64, reasoningTokens: 9, modelCalls: 2, numTurns: 2 }, { source: "turn_completed", round: 1 });
  const second = normalizeUsage({ inputTokens: 40, outputTokens: 5, totalTokens: 45,
    cachedReadTokens: 32, reasoningTokens: 3, modelCalls: 1, numTurns: 1 }, { source: "turn_completed", round: 2 });
  assert.equal(first.cache_read_input_tokens, 64);
  const total = aggregateUsage([first, second]);
  assert.equal(total.total_tokens, 165);
  assert.equal(total.model_calls, 3);
  assert.equal(total.rounds, 2);
});

test("extractUsageFromStdout finds NDJSON end event", () => {
  const stdout = [
    JSON.stringify({ type: "text", data: "hi" }),
    JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "s1",
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      total_cost_usd: 0.001
    })
  ].join("\n");
  const usage = extractUsageFromStdout(stdout);
  assert.equal(usage.num_turns, 2);
  assert.equal(usage.total_tokens, 3);
  assert.equal(usage.total_cost_usd, 0.001);
});

test("formatUsageSummary returns human string", () => {
  const s = formatUsageSummary({
    num_turns: 3,
    total_tokens: 100,
    total_cost_usd: 0.01
  });
  assert.match(s, /turns: 3/);
  assert.match(s, /tokens: 100/);
  assert.match(s, /\$0\.0100/);
});
