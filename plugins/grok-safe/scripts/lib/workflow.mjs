import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Discover *.rhai workflows from project and user directories.
 */
export function discoverWorkflows(cwd) {
  const roots = [
    { scope: "project", dir: path.join(cwd, ".grok", "workflows") },
    { scope: "user", dir: path.join(os.homedir(), ".grok", "workflows") }
  ];
  const found = [];
  const seenNames = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(root.dir).filter((name) => name.endsWith(".rhai"));
    } catch {
      continue;
    }
    for (const file of entries) {
      const full = path.join(root.dir, file);
      const baseName = file.replace(/\.rhai$/i, "");
      const meta = tryParseWorkflowMeta(full);
      const name = meta.name || baseName;
      // Project takes precedence over user for same name
      if (seenNames.has(name) && root.scope === "user") {
        continue;
      }
      seenNames.add(name);
      found.push({
        name,
        fileName: file,
        path: full,
        scope: root.scope,
        description: meta.description || null
      });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Best-effort parse of `let meta = #{ name: "...", description: "..." };`
 */
export function tryParseWorkflowMeta(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8").slice(0, 8000);
  } catch {
    return {};
  }
  const nameMatch = text.match(/name\s*:\s*"([^"]+)"/);
  const descMatch = text.match(/description\s*:\s*"([^"]+)"/);
  return {
    name: nameMatch?.[1] || null,
    description: descMatch?.[1] || null
  };
}

/**
 * Build headless prompt that invokes Grok's workflow tool.
 */
export function buildWorkflowPrompt({ name, args = {}, validateOnly = false }) {
  if (!name || !String(name).trim()) {
    throw new Error("Workflow name is required");
  }
  const safeName = String(name).trim();
  const argsJson = JSON.stringify(args ?? {});

  if (validateOnly) {
    return [
      `Use the workflow tool with validate_only: true for the workflow named "${safeName}".`,
      `Pass args: ${argsJson}`,
      `Report metadata compile/smoke-check results only. Do not run a live multi-agent execution.`,
      `Do not reimplement the workflow in plain agent steps.`
    ].join("\n");
  }

  return [
    `Run the Grok workflow named "${safeName}" using the workflow tool (not a reimplementation).`,
    `Pass args: ${argsJson}`,
    `Prefer invoking by name if the workflow is registered under project .grok/workflows/ or user ~/.grok/workflows/.`,
    `When complete, report: display name, success/failure, structured result, and any scratch report paths.`,
    `Do not modify source files except as the workflow agents are designed to do.`
  ].join("\n");
}

/**
 * Parse --arg key=value pairs into an object.
 */
export function parseWorkflowArgs(argList = []) {
  const out = {};
  for (const item of argList) {
    const text = String(item);
    const eq = text.indexOf("=");
    if (eq === -1) {
      out[text] = true;
      continue;
    }
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1);
    if (!key) continue;
    // JSON-ish values
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value === "null") value = null;
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else if (
      (value.startsWith("{") && value.endsWith("}")) ||
      (value.startsWith("[") && value.endsWith("]")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        // keep string
      }
    }
    out[key] = value;
  }
  return out;
}
