import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { matchesPath } from "./acceptance.mjs";
import { assertCommandCapability, commandCapability, effectiveCapabilities, mutatesProduction } from "./capabilities.mjs";

export const RUNTIME_DEFAULTS = { maxNarrationOnlyTurns: 2, inspectionTurns: 4, editingTurns: 24, verificationTurns: 8,
  packagingTurns: 8, publishingTurns: 4,
  inspectionSeconds: 600, editingSeconds: 1800, verificationSeconds: 600, packagingSeconds: 1800, publishingSeconds: 600,
  maxRecoveryAttempts: 2, idleSeconds: 300, heartbeatSeconds: 15, tokenSoftLimit: 0, tokenHardLimit: 0 };
const PHASE_BUDGET = {
  inspecting: { seconds: "inspectionSeconds", turns: "inspectionTurns" },
  editing: { seconds: "editingSeconds", turns: "editingTurns" },
  verifying: { seconds: "verificationSeconds", turns: "verificationTurns" },
  packaging: { seconds: "packagingSeconds", turns: "packagingTurns" },
  publishing: { seconds: "publishingSeconds", turns: "publishingTurns" }
};
const runtimeLimit = key => key.startsWith("token") ? { minimum: 0, maximum: 1000000000 } :
  { minimum: 1, maximum: key.endsWith("Seconds") ? 86400 : 1000 };
export const RUNTIME_SCHEMA = { type: "object", additionalProperties: false, properties:
  Object.fromEntries(Object.keys(RUNTIME_DEFAULTS).map(key => [key, { type: "integer", ...runtimeLimit(key) }])) };
export function normalizeRuntime(value = {}) {
  for (const [key, item] of Object.entries(value)) {
    const limits = runtimeLimit(key);
    if (!Object.hasOwn(RUNTIME_DEFAULTS, key) || !Number.isInteger(item) || item < limits.minimum || item > limits.maximum) throw new Error(`Invalid runtime budget: ${key}`);
  }
  const result = { ...RUNTIME_DEFAULTS, ...value };
  if (result.tokenSoftLimit && result.tokenHardLimit && result.tokenSoftLimit > result.tokenHardLimit) throw new Error("tokenSoftLimit cannot exceed tokenHardLimit");
  return result;
}
export function workspacePath(root, value) {
  const full = path.resolve(root, value || ".");
  let existing = full;
  while (!fs.existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  const real = fs.realpathSync(existing), canonical = fs.realpathSync(root);
  const relative = path.relative(canonical, real);
  const lexical = path.relative(root, full);
  if ([relative, lexical].some(r => r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r))) throw new Error("Path escapes the execution workspace");
  if (lexical.split(path.sep).includes(".git")) throw new Error("Git internal files are protected");
  return full;
}
export function sensitiveType(file, text = "") {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)) return "private-key";
  if (/(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s:@]+:[^\s@]+@/i.test(text)) return "connection-string";
  if (/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_/-]{20,}/i.test(text)) return "access-token";
  if (/\b(?:ssn|social_security_number)\s*[=:]/i.test(text)) return "personal-data";
  if (/^\s*(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/.test(text)) return "public-certificate";
  if (/(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|id_(?:rsa|ed25519))$/i.test(file)) {
    if (/(?:example|sample|template)$/.test(file) && !/(?:password|secret|token)\s*[=:]\s*["']?(?!example|changeme|placeholder|your_|<)[A-Za-z0-9_/-]{16,}/i.test(text)) return "test-fixture";
    return "credential";
  }
  return /\.(pem|key|p12|pfx|keystore)$/i.test(file) ? "unknown-secret-like" : null;
}
export function checkSensitive(file, text, policy = {}) {
  const type = sensitiveType(file, text);
  if (!type) return null;
  if (policy.sensitiveDenyTypes?.includes(type)) throw Object.assign(new Error(`Denied sensitive category: ${type} (${file})`), { code: "SENSITIVE_ACCESS_BLOCKED" });
  if (["public-certificate", "test-fixture"].includes(type)) return type;
  if (policy.sensitiveApproved || policy.sensitiveApprovedPaths?.includes(file)) return type;
  throw Object.assign(new Error(`Sensitive access needs exact-file approval: ${file} (${type})`), { code: "SENSITIVE_ACCESS_BLOCKED" });
}
export function commandAllowed(command, control) {
  if (!command || /[\r\n;&|<>`$]/.test(command)) return false;
  const commandPattern = value => new RegExp(`^${String(value).split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const match = rule => rule === "Bash" || /^Bash\(.*\)$/.test(rule) && commandPattern(rule.slice(5, -1)).test(command);
  return control.allow.some(match) && !control.deny.some(match);
}

export class JobPolicy {
  constructor(job, publish = () => {}) {
    this.job = job; this.publish = publish; this.runtime = normalizeRuntime(job.runtime);
    this.phase = "inspecting"; this.phaseSince = Date.now(); this.lastActivity = Date.now(); this.lastHeartbeat = 0;
    this.metrics = { turns: null, actionTurns: null, narrationOnlyTurns: null, turnEventsObserved: false, operationsStarted: 0, operationsCompleted: 0, filesRead: 0, filesEdited: 0, readVersions: 0, duplicateReads: 0, cachedReadTokensAvoided: 0 };
    this.phaseCounts = { inspecting: 0, editing: 0, verifying: 0, packaging: 0, publishing: 0 }; this.reads = new Map(); this.actions = 0; this.narration = 0;
    this.activeTools = new Map(); this.editedFiles = new Set(); this.warnings = new Set(); this.lastProgress = Date.now(); this.context = { confirmedFindings: [], todo: [], lastReport: "", lastFailure: null };
  }
  capabilities() { return effectiveCapabilities(this.job.acceptance, this.job.write !== false); }
  currentAction() {
    if (this.verificationAction) return { action: this.verificationAction, blocking: "command-running" };
    if (this.activeTools.size) {
      const tool = [...this.activeTools.values()].at(-1);
      return { action: tool.command || tool.name, blocking: tool.command ? "command-running" : "tool-running" };
    }
    if (this.phase === "verifying") return { action: "running verification", blocking: "verification" };
    return { action: this.phase, blocking: "model-turn" };
  }
  progressSnapshot() {
    if (this.verificationProgress) return this.verificationProgress;
    const todo = this.context.todo || [];
    if (!todo.length) return undefined;
    return { completed: todo.filter(item => item.status === "completed" || item.status === "done").length, total: todo.length };
  }
  heartbeatEvent() {
    const current = this.currentAction();
    const progress = this.progressSnapshot();
    return {
      phase: this.phase, status: "running", currentAction: current.action, blockingReason: current.blocking,
      lastActivityAt: new Date(this.lastActivity).toISOString(), activeTools: this.activeTools.size,
      environment: this.job.workspaceMode === "managed-worktree" ? "isolated" : "existing",
      mutatesProduction: mutatesProduction(this.capabilities()),
      ...(progress ? { progress } : {})
    };
  }
  setPhase(phase) { if (this.phase !== phase) { this.phase = phase; this.phaseSince = Date.now(); this.publish("phase", { phase }); } }
  checkTime() {
    const now = Date.now();
    if (now - this.lastHeartbeat >= this.runtime.heartbeatSeconds * 1000) {
      this.lastHeartbeat = now;
      this.publish("heartbeat", this.heartbeatEvent());
    }
    const budget = PHASE_BUDGET[this.phase] || PHASE_BUDGET.editing;
    if (now - this.phaseSince > this.runtime[budget.seconds] * 700 && !this.warnings.has(this.phase)) {
      this.warnings.add(this.phase); this.publish('stall-warning', { phase: this.phase, reason: '70% of phase time budget used', lastProgressAt: new Date(this.lastProgress).toISOString(), recommendation: 'Inspect checkpoint; split scope or send a bounded correction before the budget expires.' });
    }
    if (now - this.phaseSince > this.runtime[budget.seconds] * 1000) return { code: "PHASE_BUDGET_EXCEEDED", phase: this.phase, recoverable: true };
    if (this.activeTools.size || this.phase === "verifying") return null;
    if (now - this.lastActivity > this.runtime.idleSeconds * 1000) return { code: "STALLED", phase: this.phase, recoverable: true };
    return null;
  }
  inspectFile(value, { track = true } = {}) {
    const full = workspacePath(this.job.executionPath, value);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const relative = path.relative(this.job.executionPath, full).replace(/\\/g, "/");
    const stat = fs.statSync(full);
    if (stat.size > 4 * 1024 * 1024) throw new Error(`Use a bounded file read for large content: ${relative}`);
    const content = fs.readFileSync(full, "utf8"); checkSensitive(relative, content, this.job.security || {});
    const hash = createHash("sha256").update(content).digest("hex"); const previous = this.reads.get(relative);
    const duplicate = previous?.hash === hash;
    if (track) {
      this.metrics.readVersions += duplicate ? 0 : 1; this.metrics.duplicateReads += duplicate ? 1 : 0;
      if (!duplicate) this.lastProgress = Date.now();
      if (duplicate && this.metrics.duplicateReads % 5 === 0) this.publish('stall-warning', { reason: 'Repeated unchanged file reads', file: relative, recommendation: 'Use existing findings and attempt one bounded edit or test.' });
    }
    const entry = { path: relative, hash, bytes: stat.size, duplicate, summary: content.split(/\r?\n/).filter(l => /^(?:export |class |def |function |#|import )/.test(l)).slice(0, 12).join("\n").slice(0, 1600) };
    if (track) { this.reads.set(relative, entry); this.metrics.filesRead = this.reads.size; }
    return { ...entry, content };
  }
  before(event) {
    this.lastActivity = Date.now();
    const name = String(event.toolName || ""), input = event.toolInput || {};
    const command = input.command;
    const locations = [input.path, input.file_path, input.filePath, input.target_file, input.target_directory, input.targetDirectory,
      ...(Array.isArray(input.paths) ? input.paths : [])].filter(v => typeof v === "string");
    const mutation = /write|edit|replace|patch/i.test(name);
    const known = /^(?:read|read_file|read_text_file|grep|glob|ls|list_dir|list_directory|search|write|write_file|edit|edit_file|search_replace|apply_patch|bash|shell|run_terminal_cmd|run_terminal_command|terminal|update_plan)$/i.test(name);
    const subagent = /^(?:task|spawn_subagent|subagent)$/i.test(name), web = /web_search|web_fetch|browse/i.test(name);
    if (!known && !subagent && !web && !this.job.control.allow.includes(name)) throw new Error(`Tool capability has not been authorized: ${name}`);
    if (this.job.control.deny.some(rule => rule.toLowerCase() === name.toLowerCase())) throw new Error(`Tool denied: ${name}`);
    if (subagent && this.job.control.noSubagents) throw new Error("Subagents are disabled for this task");
    if (web && this.job.control.disableWebSearch) throw new Error("Web access is disabled for this task");
    if (mutation && !this.job.write) throw new Error("Read-only task cannot mutate files");
    const stage = this.job.acceptance?.stage;
    if (stage === "inspect" && mutation) throw new Error("Inspect stage cannot mutate files");
    if (stage === "verify" && mutation) throw new Error("Verify stage cannot mutate files");
    for (const value of locations) {
      const full = workspacePath(this.job.executionPath, value);
      const file = path.relative(this.job.executionPath, full).replace(/\\/g, "/");
      if (mutation && ((this.job.acceptance.allowedPaths?.length && !this.job.acceptance.allowedPaths.some(g => matchesPath(file, g))) || this.job.acceptance.forbiddenPaths?.some(g => matchesPath(file, g)))) throw new Error(`Write outside the acceptance scope: ${file}`);
      if (/read|grep|search/i.test(name)) this.inspectFile(value);
    }
    if (/terminal|bash|shell/i.test(name)) {
      if (!commandAllowed(command, this.job.control)) throw new Error(`Command is outside permitted capabilities: ${command || name}`);
      assertCommandCapability(command, this.capabilities());
      const needed = commandCapability(command);
      if (stage === "inspect" && (needed === "edit" || needed === "buildImage" || needed === "push" || needed === "deploy")) throw new Error(`Inspect stage cannot run ${needed} commands`);
      if (stage === "implement" && (needed === "buildImage" || needed === "push" || needed === "deploy")) throw new Error(`Implement stage cannot run ${needed} commands`);
      if (stage === "verify" && (needed === "buildImage" || needed === "push" || needed === "deploy")) throw new Error(`Verify stage cannot run ${needed} commands`);
      if (stage === "package" && (needed === "push" || needed === "deploy")) throw new Error("Package stage cannot push or deploy");
      if (needed === "push" || needed === "deploy") this.setPhase("publishing");
      else if (needed === "buildImage") this.setPhase("packaging");
      else if (this.job.acceptance.requiredCommands?.includes(command) || needed === "test") this.setPhase("verifying");
      else if (/\bgit\s+(?:add|commit)\b/.test(command)) this.setPhase("editing");
    } else if (mutation) { this.setPhase("editing"); }
    if (this.job.control.noSubagents && /spawn_subagent/i.test(name)) throw new Error("Subagents are disabled for this task");
    if (this.job.control.disableWebSearch && /web_search|web_fetch/i.test(name)) throw new Error("Web access is disabled for this task");
    this.activeTools.set(event.toolCallId || event.toolUseId || name, { name, command, startedAt: event.timestamp || new Date().toISOString() });
    this.actions += 1; this.metrics.operationsStarted += 1;
    this.publish("tool-start", { name, phase: this.phase, files: locations.map(v => path.relative(this.job.executionPath, path.resolve(this.job.executionPath, v))), command });
    return { decision: "allow" };
  }
  after(event, allowRewrite = true) {
    this.lastActivity = Date.now(); const name = String(event.toolName || ""), input = event.toolInput || {};
    const key = event.toolCallId || event.toolUseId || name, started = this.activeTools.get(key); this.activeTools.delete(key);
    if (started) this.metrics.operationsCompleted += 1;
    const result = event.toolResult ?? event.tool_response;
    const exitCode = result?.exitCode ?? result?.exit_code ?? result?.output?.exitCode;
    if (input.command && Number.isInteger(exitCode)) {
      const receipt = { source: "runner-hook", command: input.command, cwd: this.job.executionPath, startedAt: started?.startedAt, finishedAt: event.timestamp || new Date().toISOString(), exitCode,
        stdout: String(result.stdout || result.output?.stdout || "").slice(-4000), stderr: String(result.stderr || "").slice(-4000) };
      this.job.commandReceipts ||= []; this.job.commandReceipts.push(receipt);
      if (exitCode !== 0) this.context.lastFailure = receipt;
      this.publish("command-finished", receipt);
    }
    const file = input.path || input.file_path || input.filePath || input.target_file;
    if (file && /write|edit|replace|patch/i.test(name) && event.hookEventName !== 'post_tool_use_failure') {
      this.editedFiles.add(path.relative(this.job.executionPath, path.resolve(this.job.executionPath, file))); this.metrics.filesEdited = this.editedFiles.size; this.lastProgress = Date.now();
    }
    if (Number.isInteger(exitCode)) this.lastProgress = Date.now();
    const cached = file && this.reads.get(path.relative(this.job.executionPath, path.resolve(this.job.executionPath, file)).replace(/\\/g, "/"));
    if (allowRewrite && /read/i.test(name) && cached?.duplicate && result && typeof result === "object") {
      const copy = structuredClone(result); let replaced = false;
      const shorten = object => { for (const [k, v] of Object.entries(object)) {
        if (["content", "text", "output"].includes(k) && typeof v === "string" && v.length > 1000) { this.metrics.cachedReadTokensAvoided += Math.ceil(v.length / 4); object[k] = `Unchanged file already provided in this session: ${cached.path} (SHA256 ${cached.hash}).\n${cached.summary}`; replaced = true; }
        else if (v && typeof v === "object") shorten(v);
      } };
      shorten(copy);
      if (replaced) return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: copy } };
    }
    return {};
  }
  stop(event) {
    if (!this.metrics.turnEventsObserved) { this.metrics.turnEventsObserved = true; this.metrics.turns = 0; this.metrics.actionTurns = 0; this.metrics.narrationOnlyTurns = 0; }
    this.metrics.turns += 1; this.phaseCounts[this.phase] += 1;
    if (this.actions) { this.metrics.actionTurns += 1; this.narration = 0; }
    else { this.metrics.narrationOnlyTurns += 1; this.narration += 1; }
    this.actions = 0; this.context.lastReport = String(event.lastAssistantMessage || "").slice(-6000);
    const limit = this.runtime[(PHASE_BUDGET[this.phase] || PHASE_BUDGET.editing).turns];
    if ((this.job.control.maxTurns && this.metrics.turns >= this.job.control.maxTurns) || this.phaseCounts[this.phase] > limit || this.narration > this.runtime.maxNarrationOnlyTurns) return { continue: false, stopReason: "STALLED: phase or narration budget exceeded" };
    if (this.job.write && this.narration >= this.runtime.maxNarrationOnlyTurns) return { decision: "block", reason: "Codex supervisor: two narration-only rounds produced no action. Execute the smallest permitted change now, then run the required checks." };
    return {};
  }
  checkpoint() { return { phase: this.phase, currentAction: this.currentAction(), lastActivityAt: new Date(this.lastActivity).toISOString(), activeTools: this.activeTools.size, metrics: this.metrics, phaseCounts: this.phaseCounts, readFiles: [...this.reads.values()], ...this.context }; }
}
