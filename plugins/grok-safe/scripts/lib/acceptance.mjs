import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { splitRawArgumentString } from "./args.mjs";
import { resolveVerificationCommand } from "./preflight.mjs";

export const ACCEPTANCE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    objective: { type: "string" },
    allowedPaths: { type: "array", items: { type: "string" } },
    forbiddenPaths: { type: "array", items: { type: "string" } },
    expectedChange: { type: "boolean" },
    requireTests: { type: "boolean" },
    requiredCommands: { type: "array", items: { type: "string" } },
    requiredArtifacts: { type: "array", items: { type: "string" } },
    requireCommit: { type: "boolean" },
    requireCleanWorktree: { type: "boolean" }
  }
};

export function matchesPath(file, glob) {
  const pattern = glob.replace(/\\/g, "/").split("**").map(part =>
    part.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
  ).join(".*");
  return new RegExp(`^${pattern}$`).test(file.replace(/\\/g, "/"));
}

export function gitEvidence(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`Git evidence unavailable: ${args[0]}`);
  return r.stdout;
}

export function snapshotWorkspace(cwd, extraPaths = []) {
  const head = gitEvidence(cwd, ["rev-parse", "HEAD"]).trim();
  const files = {};
  const inventory = gitEvidence(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const ignoredSecrets = gitEvidence(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0").filter(f =>
    f && !/(?:^|\/)(?:\.venv|venv|node_modules|vendor|dist|build|__pycache__|\.cache)\//.test(f) &&
    /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i.test(f));
  for (const file of new Set([...inventory, ...ignoredSecrets, ...extraPaths])) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) { files[file] = null; continue; }
    const parent = path.relative(fs.realpathSync(cwd), fs.realpathSync(path.dirname(full)));
    if (parent === ".." || parent.startsWith(`..${path.sep}`) || path.isAbsolute(parent)) throw new Error(`Evidence path escapes workspace: ${file}`);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) { files[file] = "submodule"; continue; }
    const data = stat.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full);
    files[file] = createHash("sha256").update(data).update(String(stat.mode)).digest("hex");
  }
  return { head, files, status: gitEvidence(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) };
}

export function deliveryArtifactPaths(cwd, kind) {
  const root = { design: ".grok-designs", document: ".grok-docs", workflow: ".grok-workflows" }[kind];
  if (!root) return [];
  const result = [];
  function walk(relative) {
    const full = path.join(cwd, relative);
    if (!fs.existsSync(full) || fs.lstatSync(full).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) result.push(child.replace(/\\/g, "/"));
    }
  }
  walk(root);
  return result;
}

export function normalizeAcceptance(raw = {}, control = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid acceptance contract");
  for (const [key, value] of Object.entries(raw)) {
    const schema = ACCEPTANCE_SCHEMA.properties[key];
    if (!schema || (schema.type === "array" ? !Array.isArray(value) || value.some(v => typeof v !== "string") : typeof value !== schema.type)) {
      throw new Error(`Invalid acceptance field: ${key}`);
    }
  }
  const result = { expectedChange: true, requiredCommands: [], ...raw };
  for (const file of result.requiredArtifacts || []) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[*?]/.test(file)) throw new Error("Required artifacts must be exact workspace-relative paths");
  }
  if (result.requireTests && !result.requiredCommands.length) throw new Error("CAPABILITY_MISSING: requireTests needs requiredCommands");
  if (result.expectedChange === false && !result.requiredCommands.length) throw new Error("No-change acceptance requires an explicit verification command");
  const commands = [...result.requiredCommands, ...(result.requireCommit ? ["git add .", "git commit -m result"] : [])];
  for (const command of commands) {
    if (!command.trim() || /[\r\n;&|<>`$]/.test(command)) throw new Error("Invalid required command: use a single command without shell operators");
    const ruleMatches = rule => rule === "Bash" || (rule.startsWith("Bash(") && rule.endsWith(")") && matchesPath(command, rule.slice(5, -1)));
    if (!(control.allow || []).some(ruleMatches) || (control.deny || []).some(ruleMatches)) {
      throw new Error(`CAPABILITY_MISSING: command is not permitted: ${command}`);
    }
  }
  return result;
}

function classifyFailure(r) {
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.error?.code === "ETIMEDOUT") return "timeout";
  if (r.error?.code === "ENOENT" || /ModuleNotFoundError|Cannot find module/.test(text)) return "dependency-missing";
  if (/EACCES|EPERM|Permission denied/i.test(text)) return "permission-denied";
  if (/Unicode.*Error|encoding error/i.test(text)) return "path-encoding";
  if (/fixture .*not found/i.test(text)) return "fixture-missing";
  if (/error.*collect/i.test(text)) return "collection-failure";
  return r.signal || r.error ? "process-crash" : "assertion-failure";
}

export function verifyDelivery(job, processOk, exitCode) {
  const acceptance = job.acceptance || { expectedChange: true, requiredCommands: [] };
  const failures = [];
  const tests = [];
  const infrastructureErrors = [];
  const cwd = job.executionPath || job.workspaceRoot;
  let final = null, changedFiles = [], untrackedFiles = [], baseIsAncestor = false, commits = [], mergeCommits = [];
  try {
    if (job.write && !job.initialSnapshot) throw new Error("Missing initial workspace evidence");
    if (job.write || job.initialSnapshot || acceptance.requiredCommands?.length || acceptance.requiredArtifacts?.length) {
      // Execute only caller-specified, preflighted commands. Model prose is never test evidence.
      for (const command of processOk ? acceptance.requiredCommands || [] : []) {
        const startedAt = new Date().toISOString();
        let r;
        try {
          const { executable, args } = resolveVerificationCommand(command, cwd);
          r = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        } catch (error) { r = { status: null, error, stderr: error.message }; }
        tests.push({ command, cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: r.status,
          stdout: (r.stdout || "").slice(-4000), stderr: (r.stderr || r.error?.message || "").slice(-4000),
          failureType: r.status === 0 ? null : classifyFailure(r) });
        if (r.status !== 0) failures.push(`Verification failed: ${command}`);
        if (r.error || ['dependency-missing', 'permission-denied'].includes(tests.at(-1).failureType)) infrastructureErrors.push({ code: r.error?.code || tests.at(-1).failureType, command, message: r.stderr || r.error?.message });
      }
      final = snapshotWorkspace(cwd, [...(acceptance.requiredArtifacts || []), ...deliveryArtifactPaths(cwd, job.kind)]);
      const initial = job.initialSnapshot;
      if (!initial) throw new Error("Missing initial workspace evidence");
      for (const file of new Set([...Object.keys(initial.files), ...Object.keys(final.files)])) {
        if (initial.files[file] !== final.files[file]) changedFiles.push({ path: file, status: final.files[file] == null ? "deleted" : initial.files[file] == null ? "added" : "modified" });
      }
      untrackedFiles = gitEvidence(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
      const base = job.baseCommit || initial.head;
      baseIsAncestor = spawnSync("git", ["merge-base", "--is-ancestor", base, final.head], { cwd, windowsHide: true }).status === 0;
      if (!baseIsAncestor) failures.push("Result is not descended from the base commit");
      commits = gitEvidence(cwd, ["rev-list", `${base}..HEAD`]).trim().split(/\r?\n/).filter(Boolean);
      mergeCommits = gitEvidence(cwd, ["rev-list", "--merges", `${base}..HEAD`]).trim().split(/\r?\n/).filter(Boolean);
      if (job.write && acceptance.expectedChange && !changedFiles.length && final.head === initial.head) failures.push("No deliverable produced");
      if (!job.write && (changedFiles.length || final.head !== initial.head)) failures.push("Read-only task changed the workspace");
      if (acceptance.requireCommit && final.head === initial.head) failures.push("Required commit missing");
      if (acceptance.requireCleanWorktree && final.status) failures.push("Worktree is not clean");
      if (acceptance.requireTests && !tests.length) failures.push("Required verification missing");
      for (const file of acceptance.requiredArtifacts || []) {
        const full = path.resolve(cwd, file);
        const rel = fs.existsSync(full) ? path.relative(fs.realpathSync(cwd), fs.realpathSync(full)) : "..";
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0 || final.files[file] === initial.files[file]) failures.push(`Required artifact is absent, empty, unchanged or outside the workspace: ${file}`);
      }
      for (const { path: file } of changedFiles) {
        if ((acceptance.allowedPaths?.length && !acceptance.allowedPaths.some(g => matchesPath(file, g))) ||
            [...(acceptance.forbiddenPaths || []), ".git/**", ".env", ".env.*", "**/.env", "**/.env.*", "credentials.json", "**/credentials.json", "id_rsa", "id_ed25519"].some(g => matchesPath(file, g))) failures.push(`Unexpected changed path: ${file}`);
      }
      if (job.check) {
        const unexpected = untrackedFiles.filter(f => !(f in initial.files) && !acceptance.allowedPaths?.some(g => matchesPath(f, g)));
        if (unexpected.length) failures.push(`Unexpected untracked files: ${unexpected.join(", ")}`);
        const diffCheck = spawnSync("git", ["diff", "--check", base], { cwd, encoding: "utf8", windowsHide: true });
        if (diffCheck.status !== 0) failures.push("Diff has whitespace errors or conflict markers");
      }
    }
  } catch (error) { failures.push(error.message); infrastructureErrors.push({ code: 'EVIDENCE_UNAVAILABLE', message: error.message }); }
  const acceptancePassed = processOk && failures.length === 0;
  const status = !processOk ? "failed" : acceptancePassed ? "completed" : "incomplete";
  const completedAt = new Date().toISOString();
  return { status, processExited: exitCode != null, taskCompleted: acceptancePassed, acceptancePassed,
    implementationStatus: processOk ? 'reported-complete' : 'interrupted',
    artifactStatus: final ? (changedFiles.length || commits.length ? 'produced' : 'unchanged') : 'unknown',
    testStatus: infrastructureErrors.length ? 'infrastructure-error' : !tests.length ? 'not-run' : tests.every(t => t.exitCode === 0) ? 'passed' : 'failed',
    infrastructureErrors, reviewStatus: 'pending', integrationStatus: 'not-merged',
    baseCommit: job.baseCommit || job.initialSnapshot?.head || null, initialHead: job.initialSnapshot?.head || null,
    finalSnapshot: final,
    finalHead: final?.head || null, resultCommit: final && final.head !== job.initialSnapshot?.head ? final.head : null,
    workspacePath: job.workspaceRoot, worktreePath: cwd, workspaceMode: job.workspaceMode,
    changedFiles, untrackedFiles, worktreeClean: final ? !final.status : null, baseIsAncestor, commits, mergeCommits,
    cherryPickSafety: "not-checked", tests, acceptanceFailures: failures,
    requestedModel: job.requestedModel ?? job.model ?? null, resolvedModel: job.resolvedModel ?? null, modelVersion: job.modelVersion ?? null, reasoningEffort: job.effort ?? null,
    progress: { phase: status, completedAt, verificationSummary: { passed: acceptancePassed, failures, testsRun: tests.length } },
    deliveryError: failures.length ? { code: "ACCEPTANCE_FAILED", message: failures.join("; "), phase: "verifying", cause: null } : null };
}
