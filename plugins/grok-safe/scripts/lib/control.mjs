export const SAFE_SANDBOX_VALUES = ["workspace", "read-only", "strict"];
export const SAFE_PERMISSION_VALUES = ["dontAsk", "plan", "acceptEdits"];
const SANDBOX = new Set(["off", "workspace", "read-only", "strict", "devbox"]);
const SANDBOX_ALIAS = new Map([
  ["ro", "read-only"],
  ["readonly", "read-only"],
  ["ws", "workspace"]
]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan"
]);

export const SAFE_DEFAULT_ALLOW = [
  "Read", "Grep", "Glob", "Edit", "Write",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "Bash(git rev-parse*)", "Bash(npm test*)", "Bash(npm run test*)",
  "Bash(npm run lint*)", "Bash(npm run build*)", "Bash(pnpm test*)",
  "Bash(pnpm lint*)", "Bash(pnpm build*)", "Bash(yarn test*)", "Bash(pytest*)"
];

export const SAFE_DEFAULT_DENY = [
  "Bash(git push*)", "Bash(gh *)", "Bash(rm -rf*)", "Bash(del *)",
  "Bash(Remove-Item*)", "Bash(curl*)", "Bash(wget*)", "Bash(Invoke-WebRequest*)",
  "Bash(npm publish*)", "Bash(docker*)", "Bash(kubectl*)", "Bash(terraform*)",
  "Bash(aws *)", "Bash(az *)", "Bash(gcloud *)", "Bash(ssh *)", "Bash(scp *)"
];

/** Shared parseArgs boolean option names for control surface */
export const CONTROL_BOOLEAN_OPTIONS = [
  "plan",
  "no-subagents",
  "disable-web-search",
  "fork-session",
  "memory",
  "no-memory",
  "sensitive-approved"
];

/** Shared parseArgs value option names for control surface */
export const CONTROL_VALUE_OPTIONS = [
  "sandbox",
  "permission-mode",
  "agent",
  "allow",
  "deny",
  "max-turns"
];

/** Keys that accept repeated flags (array values) */
export const CONTROL_ARRAY_OPTIONS = ["allow", "deny"];

/**
 * Normalize user-facing control options into a stable config object.
 * @param {Record<string, unknown>} raw
 */
export function normalizeControlOptions(raw = {}) {
  const sensitiveApproved = Boolean(raw.sensitiveApproved || raw["sensitive-approved"]);
  const out = {
    sandbox: null,
    permissionMode: null,
    planMode: Boolean(raw.planMode || raw.plan),
    memory: raw.memory === undefined ? null : raw.memory,
    noSubagents: Boolean(raw.noSubagents || raw["no-subagents"]),
    agent: raw.agent ? String(raw.agent).trim() : null,
    allow: [...SAFE_DEFAULT_ALLOW, ...flattenStringList(raw.allow)],
    deny: [
      ...SAFE_DEFAULT_DENY,
      ...flattenStringList(raw.deny)
    ],
    disableWebSearch: raw.disableWebSearch ?? true,
    forkSession: Boolean(raw.forkSession || raw["fork-session"]),
    maxTurns: raw.maxTurns != null ? Number(raw.maxTurns) : raw["max-turns"] != null ? Number(raw["max-turns"]) : null,
    noPlan: Boolean(raw.noPlan || raw["no-plan"]),
    sensitiveApproved
  };

  // Secure worker defaults: project-scoped writes are automatic, everything else is denied.
  if (!out.sandbox) out.sandbox = "workspace";
  if (!out.planMode && !out.permissionMode) out.permissionMode = "dontAsk";
  if (out.memory == null) out.memory = false;
  out.noSubagents = raw.noSubagents ?? raw["no-subagents"] ?? true;

  if (raw.sandbox != null && raw.sandbox !== false && raw.sandbox !== "") {
    let s = String(raw.sandbox).trim().toLowerCase();
    s = SANDBOX_ALIAS.get(s) || s;
    if (s === "true") {
      s = "workspace";
    }
    if (!SANDBOX.has(s)) {
      throw new Error(
        `Invalid --sandbox: ${raw.sandbox}. Expected one of ${[...SANDBOX].join(", ")}`
      );
    }
    out.sandbox = s === "off" ? null : s;
  }

  const pmRaw = raw.permissionMode ?? raw["permission-mode"];
  if (pmRaw) {
    const pm = String(pmRaw).trim();
    if (!PERMISSION_MODES.has(pm)) {
      throw new Error(
        `Invalid --permission-mode: ${pm}. Expected one of ${[...PERMISSION_MODES].join(", ")}`
      );
    }
    out.permissionMode = pm;
  }

  if (!SAFE_PERMISSION_VALUES.includes(out.permissionMode) && out.permissionMode !== null) {
    throw new Error("Grok Safe forbids bypass/default/auto permission modes; use dontAsk or plan.");
  }
  if (!SAFE_SANDBOX_VALUES.includes(out.sandbox)) {
    throw new Error("Grok Safe requires the workspace, strict, or read-only sandbox.");
  }

  if (out.planMode && !out.permissionMode) {
    out.permissionMode = "plan";
  }

  if (out.memory !== null && typeof out.memory !== "boolean") {
    const m = String(out.memory).toLowerCase();
    if (m === "on" || m === "true" || m === "1") {
      out.memory = true;
    } else if (m === "off" || m === "false" || m === "0") {
      out.memory = false;
    } else {
      throw new Error(`Invalid --memory value: ${raw.memory}`);
    }
  }

  if (out.maxTurns != null && (!Number.isFinite(out.maxTurns) || out.maxTurns < 1)) {
    throw new Error(`Invalid --max-turns: ${raw.maxTurns ?? raw["max-turns"]}`);
  }

  if (out.agent === "") {
    out.agent = null;
  }

  return out;
}

/**
 * Convert normalized control into fields consumed by buildGrokArgs.
 */
export function controlToGrokFields(control) {
  return {
    sandbox: control.sandbox,
    permissionMode: control.permissionMode,
    noSubagents: control.noSubagents,
    agent: control.agent,
    allow: control.allow || [],
    deny: control.deny || [],
    disableWebSearch: control.disableWebSearch,
    forkSession: control.forkSession,
    maxTurns: control.maxTurns,
    noPlan: control.noPlan,
    sensitiveApproved: Boolean(control.sensitiveApproved),
    memory: control.memory == null ? null : { enable: Boolean(control.memory) }
  };
}

/**
 * Build control config from parseArgs options object.
 */
export function controlFromParsedOptions(options = {}) {
  let memory = null;
  if (options.memory && !options["no-memory"]) {
    memory = true;
  }
  if (options["no-memory"]) {
    memory = false;
  }
  return normalizeControlOptions({
    sandbox: options.sandbox,
    permissionMode: options["permission-mode"],
    planMode: options.plan,
    memory,
    noSubagents: options["no-subagents"],
    agent: options.agent,
    allow: options.allow,
    deny: options.deny,
    disableWebSearch: options["disable-web-search"],
    forkSession: options["fork-session"],
    maxTurns: options["max-turns"],
    noPlan: options["no-plan"]
    ,sensitiveApproved: options["sensitive-approved"]
  });
}

/**
 * Persistable job.config slice from control + task extras.
 */
export function controlToJobConfig(control, extras = {}) {
  return {
    sandbox: control.sandbox,
    permissionMode: control.permissionMode,
    planMode: Boolean(control.planMode),
    memory: control.memory,
    noSubagents: Boolean(control.noSubagents),
    agent: control.agent,
    allow: control.allow || [],
    deny: control.deny || [],
    disableWebSearch: Boolean(control.disableWebSearch),
    forkSession: Boolean(control.forkSession),
    maxTurns: control.maxTurns,
    bestOfN: extras.bestOfN ?? null,
    worktree: extras.worktree ?? null,
    worktreeRef: extras.worktreeRef ?? null,
    check: Boolean(extras.check),
    postPending: Boolean(extras.postPending),
    documentType: extras.documentType ?? null,
    workflowName: extras.workflowName ?? null,
    babysitAction: extras.babysitAction ?? null
    ,sensitiveApproved: Boolean(control.sensitiveApproved)
  };
}

/**
 * Merge control grok fields into a grokOptions object.
 */
export function applyControlToGrokOptions(grokOptions, control) {
  const fields = controlToGrokFields(control);
  const next = { ...grokOptions, ...fields };
  // Plan mode must not auto-approve writes with yolo
  if (fields.permissionMode === "plan") {
    next.yolo = false;
  }
  if (fields.maxTurns != null && grokOptions.maxTurns == null) {
    next.maxTurns = fields.maxTurns;
  }
  return next;
}

function flattenStringList(value) {
  if (value == null || value === false || value === "") {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    for (const part of String(item).split(",")) {
      const trimmed = part.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/**
 * Compare semver-like version strings (major.minor.patch prefix).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

export function parseSemver(version) {
  const match = String(version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [0, 0, 0];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const MIN_GROK_VERSION = "0.2.118";
export const RECOMMENDED_GROK_VERSION = "0.2.118";
