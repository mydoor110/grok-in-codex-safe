import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { matchesPath } from "../scripts/lib/acceptance.mjs";

export const SENSITIVE_TYPES = ["private-key", "credential", "access-token", "connection-string", "personal-data", "public-certificate", "test-fixture", "unknown-secret-like"];
export const SENSITIVE_EXCLUDED_DIRS = [".git", ".venv", "venv", "node_modules", "vendor", "dist", "build", "__pycache__", ".cache", ".grok-media"];

const EXECUTION_TOOLS = new Set([
  "grok_rescue",
  "grok_plan",
  "grok_review",
  "grok_adversarial_review",
  "grok_workflow",
  "grok_design",
  "grok_execute_plan",
  "grok_babysit",
  "grok_document",
  "grok_image",
  "grok_video"
]);

const PATH_FIELDS = ["designDoc", "edit", "image", "out", "output", "source"];
const SENSITIVE_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pem|p12|pfx|key|keystore))$/i;
const SAFE_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "USERNAME", "LANG", "LC_ALL", "TERM", "COLORTERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "XAI_API_KEY", "GROK_HOME", "GROK_BINARY", "GROK_CODEX_PLUGIN_STATE",
  "CODEX_PLUGIN_DATA", "RUST_LOG"
]);
const SAFE_ENV_KEYS_CASEFOLD = new Set([...SAFE_ENV_KEYS].map((key) => key.toUpperCase()));

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function resolveGitWorkspace(requested) {
  const candidate = fs.realpathSync(path.resolve(requested));
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: candidate,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !String(result.stdout || "").trim()) {
    throw new Error("Grok Safe only runs inside a Git repository.");
  }
  return fs.realpathSync(String(result.stdout).trim());
}

export function assertWorkspacePath(root, value, label) {
  if (value == null || value === "") return;
  const candidate = path.resolve(root, String(value));
  if (!inside(root, candidate)) {
    throw new Error(`${label} must remain inside the active Git workspace.`);
  }
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    if (!inside(root, real)) {
      throw new Error(`${label} resolves outside the active Git workspace.`);
    }
  }
}

export function findSensitivePaths(root, options = {}, limit = 100) {
  const findings = [];
  const ignored = new Set(SENSITIVE_EXCLUDED_DIRS);
  const walk = (dir) => {
    if (findings.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (findings.length >= limit) break;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");
      // Exclusions are restricted to known generated/dependency directories. They
      // cannot become a blanket bypass for source credentials.
      if ((options.sensitiveExclude || []).some(g => matchesPath(relative, g) || matchesPath(`${relative}/`, g))) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (SENSITIVE_NAME.test(entry.name)) {
        let type = "credential";
        // Never follow links while inspecting candidates, and bound reads.
        let body = "";
        if (entry.isFile() && fs.statSync(full).size <= 262144) body = fs.readFileSync(full, "utf8");
        if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(body)) type = "private-key";
        else if (/(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s:@]+:[^\s@]+@/i.test(body)) type = "connection-string";
        else if (/(?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_/-]{20,}/i.test(body)) type = "access-token";
        else if (/\b(?:ssn|social_security_number)\s*[=:]/i.test(body)) type = "personal-data";
        else if (/-----BEGIN CERTIFICATE-----/.test(body) && /^\s*(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/.test(body)) type = "public-certificate";
        else if (/(?:example|sample|template|dist)$/i.test(entry.name)) type = "test-fixture";
        else if (/\.(?:key|pem|p12|pfx|keystore)$/i.test(entry.name)) type = "unknown-secret-like";
        findings.push({ path: relative, type });
      }
    }
  };
  walk(root);
  return findings;
}

export function enforceInvocationSecurity(toolName, input, root) {
  for (const field of PATH_FIELDS) {
    assertWorkspacePath(root, input[field], field);
  }
  for (const ref of input.refs || []) {
    assertWorkspacePath(root, ref, "refs[]");
  }

  if (!EXECUTION_TOOLS.has(toolName)) return;
  for (const glob of input.sensitiveExclude || []) {
    const first = String(glob).replace(/\\/g, "/").split("/")[0];
    if (!SENSITIVE_EXCLUDED_DIRS.includes(first) || String(glob).split(/[\\/]/).includes("..")) {
      throw new Error("sensitiveExclude may only select known dependency/cache directories");
    }
  }
  for (const type of [...(input.sensitiveAllowTypes || []), ...(input.sensitiveDenyTypes || [])]) {
    if (!SENSITIVE_TYPES.includes(type)) throw new Error(`Unknown sensitive type: ${type}`);
  }
  if ((input.sensitiveAllowTypes || []).some(t => !["public-certificate", "test-fixture"].includes(t))) {
    throw new Error("Credentials require explicit per-file approval, not a category-wide allow");
  }
  const requestedAllows = (input.allow || []).map(String);
  const elevatedAllow = requestedAllows.find((rule) =>
    /(?:^|\()\s*(?:\*|\*\*)\s*\)?$|git\s+push|\bgh\b|curl|wget|invoke-webrequest|remove-item|rm\s+-rf|npm\s+(?:install|publish)|pnpm\s+add|yarn\s+add|pip\s+install|docker|kubectl|terraform|\baws\b|\baz\b|gcloud|ssh|scp/i.test(rule)
  );
  if (elevatedAllow && !input.sensitiveApproved) {
    throw new Error(`Elevated permission rule requires explicit user approval: ${elevatedAllow}`);
  }
  if (input.postPending || input.autoPr) {
    if (!input.sensitiveApproved) {
      throw new Error("Remote GitHub mutations require explicit user approval (sensitiveApproved=true).");
    }
  }
  const sensitive = (input.contentScoped ? [] : findSensitivePaths(root, input)).filter(f => {
    if ((input.sensitiveDenyTypes || []).includes(f.type)) return true;
    if (["public-certificate", "test-fixture", ...(input.sensitiveAllowTypes || [])].includes(f.type)) return false;
    return !(input.sensitiveApprovedPaths || []).includes(f.path) && !input.sensitiveApproved;
  });
  if (sensitive.length) {
    throw new Error(
      `Sensitive files detected; Codex must ask the user before delegating to Grok: ${sensitive.map(f => `${f.path} (${f.type})`).join(", ")}`
    );
  }
}

export function sanitizedEnvironment(source = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_ENV_KEYS_CASEFOLD.has(key.toUpperCase()) && value != null) clean[key] = value;
  }
  clean.GROK_SAFE_SUPERVISED = "1";
  return clean;
}
