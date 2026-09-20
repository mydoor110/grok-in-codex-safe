import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { splitRawArgumentString } from "./args.mjs";
import { resolveVerificationCommand, normalizePreflight, normalizeCleanupPolicy, createdResources, dockerResourceSnapshot, planCleanup, executeCleanup, leftoverFromCreated } from "./preflight.mjs";
import {
  applyCapabilities, assertCommandCapability, effectiveCapabilities, STAGES,
  mutatesProduction, normalizeCapabilities, normalizePublish, productionMutatingReceipts, isMutableTag
} from "./capabilities.mjs";

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
    requireCleanWorktree: { type: "boolean" },
    capabilities: { type: "array", items: { type: "string", enum: ["read", "edit", "test", "buildImage", "push", "deploy"] } },
    frozenTestGlobs: { type: "array", items: { type: "string" } },
    oracleChangeReasons: { type: "object", additionalProperties: { type: "string" } },
    artifactGlobs: { type: "array", items: { type: "string" } },
    stage: { type: "string", enum: ["inspect", "implement", "verify", "package", "publish"] },
    requires: { type: "string" },
    preflight: {
      type: "object", additionalProperties: false,
      properties: {
        tools: { type: "array", items: { type: "string" } },
        env: { type: "array", items: { type: "string" } },
        ports: { type: "array", items: { type: "integer" } },
        composeFiles: { type: "array", items: { type: "string" } },
        diskMb: { type: "integer" },
        registry: { type: "boolean" }
      }
    },
    cleanupPolicy: {
      type: "object", additionalProperties: false,
      properties: {
        containers: { type: "string", enum: ["always", "never"] },
        networks: { type: "string", enum: ["always", "never"] },
        volumes: { type: "string", enum: ["on_success", "retain_on_failure", "never"] },
        images: { type: "string", enum: ["retain", "never"] }
      }
    },
    publish: {
      type: "object", additionalProperties: false,
      properties: {
        images: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["repository", "tag"],
            properties: {
              repository: { type: "string" },
              tag: { type: "string" },
              digest: { type: "string" },
              immutableTag: { type: "string" }
            }
          }
        },
        allowDirtyPublish: { type: "boolean" },
        requireImmutableTags: { type: "boolean" }
      }
    }
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

function validAcceptanceValue(schema, value) {
  if (!schema) return false;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string") return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.items?.enum) return value.every(item => schema.items.enum.includes(item));
    if (schema.items?.type === "string") return value.every(item => typeof item === "string");
    if (schema.items?.type === "integer") return value.every(item => Number.isInteger(item));
    if (schema.items?.type === "object") return value.every(item => item && typeof item === "object" && !Array.isArray(item));
    return true;
  }
  if (schema.type === "object") {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    if (schema.additionalProperties?.type === "string") return Object.values(value).every(item => typeof item === "string");
    return true;
  }
  return false;
}

export function normalizeAcceptance(raw = {}, control = {}, { write = true } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid acceptance contract");
  for (const [key, value] of Object.entries(raw)) {
    if (!validAcceptanceValue(ACCEPTANCE_SCHEMA.properties[key], value)) throw new Error(`Invalid acceptance field: ${key}`);
  }
  const result = { expectedChange: true, requiredCommands: [], ...raw };
  result.capabilities = normalizeCapabilities(raw.capabilities, { write });
  result.frozenTestGlobs = raw.frozenTestGlobs || [];
  result.artifactGlobs = raw.artifactGlobs || [];
  result.oracleChangeReasons = raw.oracleChangeReasons || {};
  result.stage = raw.stage || null;
  result.requires = raw.requires || null;
  result.preflight = normalizePreflight(raw.preflight, result.capabilities);
  result.cleanupPolicy = normalizeCleanupPolicy(raw.cleanupPolicy, result.capabilities);
  result.publish = normalizePublish(raw.publish);
  if (result.stage && !STAGES.includes(result.stage)) throw new Error("Invalid acceptance field: stage");
  if (result.stage === "package" && !result.capabilities.includes("buildImage")) throw new Error("CAPABILITY_MISSING: stage=package requires buildImage");
  if (result.stage === "publish" && !mutatesProduction(result.capabilities)) throw new Error("CAPABILITY_MISSING: stage=publish requires push or deploy");
  if (result.requires) {
    if (path.isAbsolute(result.requires) || result.requires.split(/[\\/]/).includes("..")) throw new Error("requires must be a workspace-relative stage result path");
  }
  const effective = applyCapabilities(control, result.capabilities, { sensitiveApproved: control.sensitiveApproved });
  if (control && typeof control === "object") { control.allow = effective.allow; control.deny = effective.deny; }
  if ((result.capabilities.includes("push") || result.capabilities.includes("deploy")) && !result.publish?.images?.length) {
    throw new Error("CAPABILITY_MISSING: push/deploy requires publish.images target preview");
  }
  for (const file of result.requiredArtifacts || []) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[*?]/.test(file)) throw new Error("Required artifacts must be exact workspace-relative paths");
  }
  if (result.stage === "inspect" && raw.expectedChange == null) result.expectedChange = false;
  if (result.requireTests && !result.requiredCommands.length) throw new Error("CAPABILITY_MISSING: requireTests needs requiredCommands");
  if (result.expectedChange === false && !result.requiredCommands.length && result.stage !== "inspect") throw new Error("No-change acceptance requires an explicit verification command");
  const commands = [...result.requiredCommands, ...(result.requireCommit ? ["git add .", "git commit -m result"] : [])];
  for (const command of commands) {
    if (!command.trim() || /[\r\n;&|<>`$]/.test(command)) throw new Error("Invalid required command: use a single command without shell operators");
    assertCommandCapability(command, result.capabilities);
    const ruleMatches = rule => rule === "Bash" || (rule.startsWith("Bash(") && rule.endsWith(")") && matchesPath(command, rule.slice(5, -1)));
    if (!(effective.allow || []).some(ruleMatches) || (effective.deny || []).some(ruleMatches)) {
      throw new Error(`CAPABILITY_MISSING: command is not permitted: ${command}`);
    }
  }
  return result;
}

export function classifyFailureType(kind, text = "") {
  if (["dependency-missing", "permission-denied"].includes(kind)) return "infrastructure";
  if (["timeout", "process-crash"].includes(kind)) return "environment";
  if (["fixture-missing", "collection-failure", "path-encoding"].includes(kind)) return "test_harness";
  if (/ECONNREFUSED|port is already allocated|bind: address already in use|docker(?:-compose)?|No such file or directory|ENOENT|compose.*mount/i.test(text)) return "environment";
  if (/ReferenceError|is not defined|SyntaxError|Cannot find module|ModuleNotFoundError/i.test(text)) return "test_harness";
  if (/AssertionError|assert(?:ion)?\.|expected .* but|FAIL\s+\S/i.test(text)) return "product";
  return "unknown";
}

function classifyFailure(r) {
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  let failureKind = "assertion-failure";
  if (r.error?.code === "ETIMEDOUT") failureKind = "timeout";
  else if (r.error?.code === "ENOENT" || /ModuleNotFoundError|Cannot find module/.test(text)) failureKind = "dependency-missing";
  else if (/EACCES|EPERM|Permission denied/i.test(text)) failureKind = "permission-denied";
  else if (/Unicode.*Error|encoding error/i.test(text)) failureKind = "path-encoding";
  else if (/fixture .*not found/i.test(text)) failureKind = "fixture-missing";
  else if (/error.*collect/i.test(text)) failureKind = "collection-failure";
  else if (r.signal || r.error) failureKind = "process-crash";
  return { failureKind, failureType: classifyFailureType(failureKind, text) };
}

export function clusterTestFailures(tests = []) {
  const map = new Map();
  for (const test of tests.filter(item => item.exitCode !== 0)) {
    const text = `${test.stderr || ""}\n${test.stdout || ""}`;
    const line = (text.match(/AssertionError:[^\n]+|Error: [^\n]+|FAIL[^\n]+/) || [test.failureKind || "failed"])[0].slice(0, 160);
    const key = `${test.failureType || "unknown"}:${line}`;
    const entry = map.get(key) || { key, failureType: test.failureType || "unknown", sample: line, count: 0, commands: [] };
    entry.count += 1;
    entry.commands.push(test.command);
    map.set(key, entry);
  }
  return [...map.values()];
}

export function summarizeTests(tests = []) {
  const counts = { passed: 0, failed: 0, harnessFailures: 0, environmentFailures: 0, infrastructureFailures: 0, productFailures: 0, unknownFailures: 0 };
  for (const test of tests) {
    if (test.exitCode === 0) { counts.passed += 1; continue; }
    counts.failed += 1;
    const bucket = {
      test_harness: "harnessFailures", environment: "environmentFailures",
      infrastructure: "infrastructureFailures", product: "productFailures", unknown: "unknownFailures"
    }[test.failureType] || "unknownFailures";
    counts[bucket] += 1;
  }
  const clusters = clusterTestFailures(tests);
  return { ...counts, countUnit: "command", failureClusters: clusters.length,
    independentDefects: clusters.filter(item => item.failureType === "product").length,
    clusteringMethod: "heuristic-error-signature", clusters };
}

export function assertPreviousStage(cwd, relative) {
  if (!relative) return;
  const full = path.resolve(cwd, relative);
  const rel = path.relative(path.resolve(cwd), full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Stage requirement escapes workspace: ${relative}`);
  if (!fs.existsSync(full)) throw new Error(`Required previous stage result is missing: ${relative}`);
  const realRelative = path.relative(fs.realpathSync(cwd), fs.realpathSync(full));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`Stage requirement escapes workspace: ${relative}`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(full, "utf8")); }
  catch { throw new Error(`Required previous stage result is not JSON: ${relative}`); }
  if (!["success", "completed"].includes(parsed.status)) throw new Error(`Previous stage is not successful: ${relative} (${parsed.status || "unknown"})`);
}

export function oracleDiff(cwd, file, base = "HEAD") {
  const result = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", base, "--", file], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.slice(0, 8000);
  const full = path.join(cwd, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return "";
  try { return fs.readFileSync(full, "utf8").slice(0, 4000); } catch { return ""; }
}

export function collectArtifactFiles(cwd, acceptance = {}) {
  const files = new Set(acceptance.requiredArtifacts || []);
  if (acceptance.artifactGlobs?.length) {
    const inventory = gitEvidence(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
    for (const file of inventory) if (acceptance.artifactGlobs.some(glob => matchesPath(file, glob))) files.add(file);
  }
  return [...files];
}

export function writeArtifactManifest(cwd, jobId, files, report) {
  if (!cwd || !jobId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(String(jobId))) throw new Error("Invalid artifact job id");
  const dir = path.join(cwd, "artifacts", String(jobId));
  const rel = path.relative(path.resolve(cwd), dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Artifact directory escapes workspace");
  const safeDestination = full => {
    const relative = path.relative(path.resolve(cwd), full);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Artifact path escapes workspace");
    let current = path.resolve(cwd);
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Artifact path contains a symbolic link"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return full;
  };
  safeDestination(dir);
  fs.mkdirSync(dir, { recursive: true });
  const deliveryPath = safeDestination(path.join(dir, "delivery.json"));
  const manifestPath = safeDestination(path.join(dir, "manifest.json"));
  // A failed retry must never leave an earlier successful stage result consumable.
  fs.rmSync(deliveryPath, { force: true });
  const entries = [];
  for (const file of files || []) {
    const src = path.resolve(cwd, file);
    const inside = path.relative(path.resolve(cwd), src);
    if (inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`Artifact is missing or outside the workspace: ${file}`);
    const real = path.relative(fs.realpathSync(cwd), fs.realpathSync(src));
    if (real === ".." || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) throw new Error(`Artifact escapes workspace: ${file}`);
    if (fs.statSync(src).size > 8 * 1024 * 1024) throw new Error(`Artifact exceeds 8 MiB limit: ${file}`);
    if (["delivery.json", "manifest.json"].includes(inside.replace(/\\/g, "/"))) throw new Error(`Reserved artifact path: ${file}`);
    const dest = safeDestination(path.join(dir, inside));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    entries.push({ path: inside.replace(/\\/g, "/"), sha256: createHash("sha256").update(fs.readFileSync(dest)).digest("hex"), bytes: fs.statSync(dest).size });
  }
  const deliveryRel = "delivery.json";
  const delivery = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  entries.push({ path: deliveryRel, sha256: createHash("sha256").update(delivery).digest("hex"), bytes: delivery.length });
  const manifest = { jobId, createdAt: new Date().toISOString(), files: entries };
  manifest.sha256 = createHash("sha256").update(JSON.stringify({ jobId: manifest.jobId, files: entries })).digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(deliveryPath, delivery);
  return { dir: path.relative(cwd, dir).replace(/\\/g, "/"), manifest };
}

export function verifyDelivery(job, processOk, exitCode, onProgress = () => {}) {
  const acceptance = job.acceptance || { expectedChange: true, requiredCommands: [] };
  const failures = [];
  const tests = [];
  const infrastructureErrors = [];
  const oracleChanged = [];
  const cwd = job.executionPath || job.workspaceRoot;
  let final = null, changedFiles = [], untrackedFiles = [], baseIsAncestor = false, commits = [], mergeCommits = [];
  try {
    if (job.write && !job.initialSnapshot) throw new Error("Missing initial workspace evidence");
    assertPreviousStage(cwd, acceptance.requires);
    if (job.write || job.initialSnapshot || acceptance.requiredCommands?.length || acceptance.requiredArtifacts?.length) {
      // Execute only caller-specified, preflighted commands. Model prose is never test evidence.
      for (const command of processOk ? acceptance.requiredCommands || [] : []) {
        const startedAt = new Date().toISOString();
        onProgress({ type: "verification-command-started", phase: "verifying", status: "running", currentAction: command,
          lastActivityAt: startedAt, progress: { completed: tests.length, total: acceptance.requiredCommands.length, unit: "command" } });
        let r;
        try {
          const { executable, args } = resolveVerificationCommand(command, cwd);
          r = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        } catch (error) { r = { status: null, error, stderr: error.message }; }
        const classified = r.status === 0 ? { failureKind: null, failureType: null } : classifyFailure(r);
        tests.push({ command, cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: r.status,
          stdout: (r.stdout || "").slice(-4000), stderr: (r.stderr || r.error?.message || "").slice(-4000),
          failureKind: classified.failureKind, failureType: classified.failureType });
        onProgress({ type: "verification-command-finished", phase: "verifying", status: r.status === 0 ? "completed" : "failed",
          currentAction: command, exitCode: r.status, failureType: classified.failureType, lastActivityAt: tests.at(-1).finishedAt,
          progress: { completed: tests.length, total: acceptance.requiredCommands.length, unit: "command" } });
        if (r.status !== 0) failures.push(`Verification failed: ${command}`);
        if (r.error || ['infrastructure', 'environment'].includes(classified.failureType) || ['dependency-missing', 'permission-denied'].includes(classified.failureKind)) {
          infrastructureErrors.push({ code: r.error?.code || classified.failureKind || classified.failureType, command, message: r.stderr || r.error?.message, failureType: classified.failureType });
        }
      }
      final = snapshotWorkspace(cwd, [...(acceptance.requiredArtifacts || []), ...deliveryArtifactPaths(cwd, job.kind)]);
      const initial = job.initialSnapshot;
      if (!initial) throw new Error("Missing initial workspace evidence");
      for (const file of new Set([...Object.keys(initial.files), ...Object.keys(final.files)])) {
        if (job.generatedArtifactSnapshot?.[file] === final.files[file] && final.files[file] != null) continue;
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
      if (acceptance.frozenTestGlobs?.length) {
        const reasons = acceptance.oracleChangeReasons || {};
        for (const file of new Set([...Object.keys(initial.files), ...Object.keys(final.files)])) {
          if (acceptance.frozenTestGlobs.some(glob => matchesPath(file, glob)) && initial.files[file] !== final.files[file]) {
            const reason = typeof reasons[file] === "string" ? reasons[file].trim() : "";
            oracleChanged.push({ path: file, initialHash: initial.files[file] || null, finalHash: final.files[file] || null, diff: oracleDiff(cwd, file, initial.head), diffBase: initial.head, reason: reason || null });
            if (!reason) failures.push(`Oracle/test file changed without a reason: ${file}`);
          }
        }
      }
      if (acceptance.stage === "inspect" && (changedFiles.length || final.head !== initial.head)) failures.push("Inspect stage cannot mutate the workspace");
      if (acceptance.stage === "verify" && changedFiles.some(file => !String(file.path).replace(/\\/g, "/").startsWith("artifacts/"))) failures.push("Verify stage cannot mutate the workspace");
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
        const unexpected = untrackedFiles.filter(f => !(f in initial.files) && !String(f).replace(/\\/g, "/").startsWith("artifacts/") && !acceptance.allowedPaths?.some(g => matchesPath(f, g)));
        if (unexpected.length) failures.push(`Unexpected untracked files: ${unexpected.join(", ")}`);
        const diffCheck = spawnSync("git", ["diff", "--check", base], { cwd, encoding: "utf8", windowsHide: true });
        if (diffCheck.status !== 0) failures.push("Diff has whitespace errors or conflict markers");
      }
    }
  } catch (error) { failures.push(error.message); infrastructureErrors.push({ code: 'EVIDENCE_UNAVAILABLE', message: error.message }); }
  const completedAt = new Date().toISOString();
  const testSummary = summarizeTests(tests);
  const capabilities = effectiveCapabilities(acceptance, job.write !== false);
  const mutating = productionMutatingReceipts(job.commandReceipts || []);
  const productionChanged = mutating.length > 0;
  if (productionChanged && !mutatesProduction(capabilities)) {
    failures.push("Production-mutating command without push/deploy capability");
  }
  const images = (acceptance.publish?.images || []).map(image => ({ ...image }));
  if (mutatesProduction(capabilities) || productionChanged) {
    const dirty = Boolean(job.sourceDirty) || Boolean(final?.status);
    if (dirty && !acceptance.publish?.allowDirtyPublish) failures.push("Dirty worktree cannot be published without allowDirtyPublish");
    if (!images.length) failures.push("push/deploy requires publish.images target preview");
    if (acceptance.publish?.requireImmutableTags !== false) {
      for (const image of images) {
        if (isMutableTag(image.tag) && isMutableTag(image.immutableTag) && !image.digest) failures.push(`Mutable tag without immutable tag or digest: ${image.repository}:${image.tag}`);
      }
    }
  }
  const remainingRisks = [];
  if (oracleChanged.length) remainingRisks.push({ type: "oracle-changed", paths: oracleChanged.map(item => item.path || item) });
  if (testSummary.unknownFailures) remainingRisks.push({ type: "unclassified-test-failures", count: testSummary.unknownFailures });
  if (testSummary.harnessFailures) remainingRisks.push({ type: "test-harness-failures", count: testSummary.harnessFailures });
  if (testSummary.environmentFailures) remainingRisks.push({ type: "environment-failures", count: testSummary.environmentFailures });
  if ((productionChanged || mutatesProduction(capabilities)) && (job.sourceDirty || final?.status) && acceptance.publish?.allowDirtyPublish) remainingRisks.push({ type: "dirty-publish" });
  if (images.some(image => isMutableTag(image.tag))) remainingRisks.push({ type: "mutable-tag" });
  let diffHash = null;
  const sourceTreeHash = final ? createHash("sha256").update(JSON.stringify(Object.entries(final.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex") : null;
  try {
    if (final) diffHash = createHash("sha256").update(gitEvidence(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"])).digest("hex");
  } catch (error) { infrastructureErrors.push({ code: "SOURCE_EVIDENCE_FAILED", message: error.message }); failures.push(error.message); }
  const passedAfterPublish = processOk && failures.length === 0;
  let cleanup = { created: { containers: [], volumes: [], networks: [], images: [] }, remaining: [], cleaned: [] };
  if (job.environment?.dockerSnapshot) {
    const created = createdResources(job.environment.dockerSnapshot, dockerResourceSnapshot());
    const policy = acceptance.cleanupPolicy || normalizeCleanupPolicy(null, capabilities);
    const executed = executeCleanup(planCleanup(created, policy, passedAfterPublish), job.id);
    cleanup = { policy, created, cleaned: executed.cleaned, remaining: leftoverFromCreated(created, executed.cleaned), errors: executed.errors };
  }
  if (cleanup.errors?.length) remainingRisks.push({ type: "cleanup-failures", errors: cleanup.errors });
  const result = { status: !processOk ? "failed" : passedAfterPublish ? "completed" : "incomplete", processExited: exitCode != null, taskCompleted: passedAfterPublish, acceptancePassed: passedAfterPublish,
    implementationStatus: processOk ? 'reported-complete' : 'interrupted',
    artifactStatus: final ? (changedFiles.length || commits.length ? 'produced' : 'unchanged') : 'unknown',
    testStatus: infrastructureErrors.length ? 'infrastructure-error' : !tests.length ? 'not-run' : tests.every(t => t.exitCode === 0) ? 'passed' : 'failed',
    infrastructureErrors, reviewStatus: 'pending', integrationStatus: 'not-merged',
    baseCommit: job.baseCommit || job.initialSnapshot?.head || null, initialHead: job.initialSnapshot?.head || null,
    finalSnapshot: final,
    finalHead: final?.head || null, resultCommit: final && final.head !== job.initialSnapshot?.head ? final.head : null,
    workspacePath: job.workspaceRoot, worktreePath: cwd, workspaceMode: job.workspaceMode,
    changedFiles, untrackedFiles, worktreeClean: final ? !final.status : null, baseIsAncestor, commits, mergeCommits,
    cherryPickSafety: "not-checked", tests, testSummary, oracleChanged,
    images, productionChanged, remainingRisks, artifacts: null, cleanup, stageResult: null,
    sourceCommit: final?.head || job.baseCommit || null, sourceDirty: Boolean(job.sourceDirty) || Boolean(final?.status),
    diffHash, sourceTreeHash, publishPreview: images, capabilities, stage: acceptance.stage || null,
    acceptanceFailures: failures,
    requestedModel: job.requestedModel ?? job.model ?? null, resolvedModel: job.resolvedModel ?? null, modelVersion: job.modelVersion ?? null, reasoningEffort: job.effort ?? null,
    progress: { phase: !processOk ? "failed" : passedAfterPublish ? "completed" : "incomplete", completedAt, verificationSummary: { passed: passedAfterPublish, failures, testsRun: tests.length, testSummary } },
    deliveryError: failures.length ? { code: "ACCEPTANCE_FAILED", message: failures.join("; "), phase: "verifying", cause: null } : null };
  try {
    const { finalSnapshot, ...report } = result;
    result.artifacts = writeArtifactManifest(cwd, job.id, collectArtifactFiles(cwd, acceptance), report);
    result.stageResult = result.artifacts ? `${result.artifacts.dir}/delivery.json` : null;
    // Resume compares the actual post-report workspace, not the pre-report source snapshot.
    if (result.artifacts && final) {
      result.finalSnapshot = snapshotWorkspace(cwd, [...(acceptance.requiredArtifacts || []), ...deliveryArtifactPaths(cwd, job.kind)]);
      const generated = [...result.artifacts.manifest.files.map(file => `${result.artifacts.dir}/${file.path}`), `${result.artifacts.dir}/manifest.json`];
      result.generatedArtifactSnapshot = { ...(job.generatedArtifactSnapshot || {}),
        ...Object.fromEntries(generated.map(file => [file, result.finalSnapshot.files[file]]).filter(([, hash]) => hash != null)) };
    }
  } catch (error) {
    infrastructureErrors.push({ code: "ARTIFACT_PERSIST_FAILED", message: error.message });
    failures.push(error.message);
    result.status = processOk ? "incomplete" : "failed";
    result.taskCompleted = result.acceptancePassed = false;
    result.testStatus = "infrastructure-error";
    result.progress.phase = result.status;
    result.progress.verificationSummary.passed = false;
    result.deliveryError = { code: "ARTIFACT_PERSIST_FAILED", message: error.message, phase: "verifying", cause: null };
  }
  return result;
}
