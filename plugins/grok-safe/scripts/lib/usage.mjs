/**
 * Extract spend/usage fields from headless Grok JSON (or streaming end event).
 */
const number = (...values) => values.find(value => typeof value === "number" && Number.isFinite(value)) ?? null;

/** Normalize headless snake_case and ACP camelCase usage into one schema. */
export function normalizeUsage(raw, metadata = {}) {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  const normalized = {
    input_tokens: number(usage.input_tokens, usage.inputTokens),
    output_tokens: number(usage.output_tokens, usage.outputTokens),
    total_tokens: number(usage.total_tokens, usage.totalTokens),
    cache_read_input_tokens: number(usage.cache_read_input_tokens, usage.cachedReadTokens),
    cache_creation_input_tokens: number(usage.cache_creation_input_tokens, usage.cacheCreationTokens),
    reasoning_tokens: number(usage.reasoning_tokens, usage.reasoningTokens),
    model_calls: number(usage.model_calls, usage.modelCalls),
    api_duration_ms: number(usage.api_duration_ms, usage.apiDurationMs),
    cost_usd_ticks: number(usage.cost_usd_ticks, usage.costUsdTicks),
    total_cost_usd: number(raw.total_cost_usd, usage.total_cost_usd),
    num_turns: number(raw.num_turns, raw.numTurns, usage.num_turns, usage.numTurns),
    modelUsage: raw.modelUsage ?? usage.modelUsage ?? null,
    usage_is_incomplete: Boolean(raw.usage_is_incomplete ?? usage.usage_is_incomplete),
    ...metadata
  };
  if (normalized.total_tokens == null && normalized.input_tokens != null && normalized.output_tokens != null) {
    normalized.total_tokens = normalized.input_tokens + normalized.output_tokens;
  }
  const measured = Object.entries(normalized).some(([key, value]) =>
    !["modelUsage", "usage_is_incomplete", "source", "round"].includes(key) && value != null);
  return measured || normalized.modelUsage ? normalized : null;
}

/** Sum terminal per-round measurements. Do not feed cumulative usage_update snapshots here. */
export function aggregateUsage(rounds = []) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  const fields = ["input_tokens", "output_tokens", "total_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens", "reasoning_tokens", "model_calls", "api_duration_ms", "cost_usd_ticks", "total_cost_usd", "num_turns"];
  const result = { rounds: rounds.length, usage_is_incomplete: rounds.some(item => item?.usage_is_incomplete) };
  for (const field of fields) {
    const values = rounds.map(item => item?.[field]).filter(value => typeof value === "number" && Number.isFinite(value));
    result[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return result;
}

export function extractUsageFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  // Prefer full parsed object; streaming may nest under type:end
  let root = parsed;
  if (parsed.parsed && typeof parsed.parsed === "object") {
    root = parsed.parsed;
  }
  if (root.type === "end" || root.type === "result") {
    // already terminal shape
  } else if (root.type === "error" && !root.usage && root.total_cost_usd == null) {
    return null;
  }

  const usage = root.usage && typeof root.usage === "object" ? root.usage : null;
  const hasSpend =
    usage != null ||
    root.total_cost_usd != null ||
    root.num_turns != null ||
    root.modelUsage != null ||
    root.usage_is_incomplete;

  if (!hasSpend) {
    return null;
  }

  return normalizeUsage(root);
}

/**
 * Scan NDJSON streaming-json stdout for the final `end` event usage.
 */
export function extractUsageFromStdout(stdout) {
  if (!stdout || typeof stdout !== "string") {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // Single JSON object
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    try {
      return extractUsageFromParsed(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  // NDJSON: walk lines bottom-up for type end / result
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && (obj.type === "end" || obj.type === "result" || obj.usage || obj.total_cost_usd != null)) {
        const usage = extractUsageFromParsed(obj);
        if (usage) {
          return usage;
        }
      }
    } catch {
      // continue
    }
  }

  // Full-document JSON at end of stream
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return extractUsageFromParsed(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
    } catch {
      return null;
    }
  }

  return null;
}

export function formatUsageSummary(usage) {
  if (!usage) {
    return null;
  }
  const parts = [];
  if (usage.num_turns != null) {
    parts.push(`turns: ${usage.num_turns}`);
  }
  if (usage.total_tokens != null) {
    parts.push(`tokens: ${usage.total_tokens}`);
  } else if (usage.input_tokens != null || usage.output_tokens != null) {
    parts.push(`tokens: in ${usage.input_tokens ?? "?"} / out ${usage.output_tokens ?? "?"}`);
  }
  if (usage.total_cost_usd != null && !usage.usage_is_incomplete) {
    parts.push(`cost: $${Number(usage.total_cost_usd).toFixed(4)}`);
  }
  if (usage.usage_is_incomplete) {
    parts.push("usage incomplete");
  }
  return parts.length ? parts.join(" · ") : null;
}
