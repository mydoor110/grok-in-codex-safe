import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { splitRawArgumentString } from './args.mjs';
import { assertPreviousStage } from './acceptance.mjs';

export const VERIFIER_PATH = fileURLToPath(new URL('../verification-worker.mjs', import.meta.url));
export function preflightError(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

export function resolveExecutable(binary, cwd, env = process.env) {
  if (binary === 'node') return process.execPath;
  const dirs = path.isAbsolute(binary) || /[\\/]/.test(binary) ? [''] : (env.PATH || env.Path || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' && !path.extname(binary) ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs) for (const suffix of suffixes) {
    const file = path.resolve(cwd, dir, binary + suffix);
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK); return file; } } catch {}
  }
  throw preflightError('EXECUTABLE_MISSING', `Executable unavailable: ${binary}`);
}

export function resolveVerificationCommand(command, cwd, env = process.env) {
  const [binary, ...args] = splitRawArgumentString(command);
  if (process.platform === 'win32' && /^npm(?:\.cmd)?$/i.test(binary)) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (fs.existsSync(cli)) return { command, executable: process.execPath, args: [cli, ...args] };
  }
  const executable = resolveExecutable(binary, cwd, env);
  if (/\.(cmd|bat)$/i.test(executable)) throw preflightError('EXECUTABLE_UNSUPPORTED', `Use an explicit interpreter and script instead of a shell wrapper: ${binary}`);
  return { command, executable, args };
}

export function verifyInstallation(entry = VERIFIER_PATH) {
  const seen = new Set();
  const inspect = file => {
    if (seen.has(file)) return; seen.add(file);
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { throw preflightError('INSTALLATION_INCOMPLETE', `Required component missing: ${file}`); }
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) inspect(path.resolve(path.dirname(file), match[1]));
  };
  inspect(entry);
  const probe = spawnSync(process.execPath, [entry, '--self-test'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (probe.status !== 0 || probe.stdout.trim() !== 'verification-ready') throw preflightError('INSTALLATION_INCOMPLETE', `Verification worker cannot initialize: ${probe.stderr || probe.error?.message || probe.status}`);
  return { verified: true, components: seen.size, node: process.execPath, nodeVersion: process.version };
}

export function preflightExecution(cwd, acceptance, control, { entry = VERIFIER_PATH, installation: checkedInstallation, checkWritable = true } = {}) {
  assertPreviousStage(cwd, acceptance.requires);
  const installation = checkedInstallation || verifyInstallation(entry);
  const commands = (acceptance.requiredCommands || []).map(command => resolveVerificationCommand(command, cwd));
  const interpreters = {};
  for (const binary of ['node', 'python', 'python3', 'git']) { try { interpreters[binary] = resolveExecutable(binary, cwd); } catch {} }
  if (checkWritable && control.sandbox !== 'read-only') {
    const probe = path.join(cwd, `.grok-write-probe-${randomUUID()}`);
    try { fs.writeFileSync(probe, '', { flag: 'wx' }); fs.unlinkSync(probe); }
    catch (error) { throw preflightError('WORKSPACE_NOT_WRITABLE', error.message); }
  }
  const capabilities = acceptance.capabilities || [];
  const spec = normalizePreflight(acceptance.preflight, capabilities);
  const extras = runContractPreflight(cwd, spec, capabilities, process.env);
  return { installation, commands, interpreters, cwd, temporaryDirectory: os.tmpdir(),
    temporaryDirectoryPolicy: 'Interpreter-managed temporary files only; direct file tools remain workspace-scoped.',
    dependencyCoverage: 'Verifier imports and command executables checked; project test dependencies are verified when the exact test commands run.',
    preflight: spec, dockerSnapshot: extras.dockerSnapshot, checks: extras.checks,
    capabilities: { allow: control.allow, deny: control.deny,
    sandbox: control.sandbox, web: !control.disableWebSearch, subagents: !control.noSubagents,
    note: 'Visible native tools are subject to these rules and workspace/sensitive-file checks; denied commands must not be retried under aliases.' } };
}

export function normalizePreflight(raw, capabilities = []) {
  const wantsDocker = capabilities.includes("buildImage") || capabilities.includes("push") || capabilities.includes("deploy");
  const spec = { tools: [], env: [], ports: [], composeFiles: [], diskMb: wantsDocker ? 256 : null, registry: false };
  if (raw == null) return spec;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw preflightError("INVALID_PREFLIGHT", "Invalid acceptance field: preflight");
  if (raw.tools) { if (!Array.isArray(raw.tools) || raw.tools.some(v => typeof v !== "string" || !v.trim())) throw preflightError("INVALID_PREFLIGHT", "preflight.tools must be command names"); spec.tools = raw.tools.map(v => v.trim()); }
  if (raw.env) { if (!Array.isArray(raw.env) || raw.env.some(v => typeof v !== "string" || !v.trim())) throw preflightError("INVALID_PREFLIGHT", "preflight.env must be environment variable names"); spec.env = raw.env.map(v => v.trim()); }
  if (raw.ports) {
    if (!Array.isArray(raw.ports) || raw.ports.some(v => !Number.isInteger(v) || v < 1 || v > 65535)) throw preflightError("INVALID_PREFLIGHT", "preflight.ports must be integers 1-65535");
    spec.ports = raw.ports;
  }
  if (raw.composeFiles) {
    if (!Array.isArray(raw.composeFiles) || raw.composeFiles.some(v => typeof v !== "string" || path.isAbsolute(v) || v.split(/[\\/]/).includes(".."))) {
      throw preflightError("INVALID_PREFLIGHT", "preflight.composeFiles must be workspace-relative paths");
    }
    spec.composeFiles = raw.composeFiles;
  }
  if (raw.diskMb != null) {
    if (!Number.isInteger(raw.diskMb) || raw.diskMb < 1) throw preflightError("INVALID_PREFLIGHT", "preflight.diskMb must be a positive integer");
    spec.diskMb = raw.diskMb;
  }
  if (raw.registry != null) { if (typeof raw.registry !== "boolean") throw preflightError("INVALID_PREFLIGHT", "preflight.registry must be boolean"); spec.registry = raw.registry; }
  return spec;
}

export function normalizeCleanupPolicy(raw, capabilities = []) {
  const wantsDocker = capabilities.includes("buildImage") || capabilities.includes("push");
  const spec = {
    containers: wantsDocker ? "always" : "never",
    networks: wantsDocker ? "always" : "never",
    volumes: wantsDocker ? "retain_on_failure" : "never",
    images: "retain"
  };
  if (raw == null) return spec;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw preflightError("INVALID_CLEANUP", "Invalid acceptance field: cleanupPolicy");
  const allowed = {
    containers: ["always", "never"], networks: ["always", "never"],
    volumes: ["on_success", "retain_on_failure", "never"], images: ["retain", "never"]
  };
  for (const [key, values] of Object.entries(allowed)) {
    if (raw[key] != null) {
      if (!values.includes(raw[key])) throw preflightError("INVALID_CLEANUP", `cleanupPolicy.${key} must be one of ${values.join(", ")}`);
      spec[key] = raw[key];
    }
  }
  return spec;
}

export function composeBindMounts(text) {
  const mounts = [];
  for (const match of String(text || "").matchAll(/^[ \t]*-[ \t]+["']?(\.\/|\.\.\/|~\/)([^:"'\s]+):/gm)) mounts.push(match[1] + match[2]);
  for (const match of String(text || "").matchAll(/^[ \t]+(?:source|SOURCE):[ \t]+["']?(\.\/|\.\.\/|~\/)([^"'\s]+)["']?/gm)) mounts.push(match[1] + match[2]);
  return [...new Set(mounts)];
}

export function checkComposeFiles(cwd, composeFiles = []) {
  const checks = [];
  for (const relative of composeFiles) {
    const full = path.resolve(cwd, relative);
    const parent = path.relative(path.resolve(cwd), full);
    if (parent.startsWith("..") || path.isAbsolute(parent)) throw preflightError("COMPOSE_PATH_ESCAPES", `Compose file escapes workspace: ${relative}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw preflightError("COMPOSE_MISSING", `Compose file not found: ${relative}`);
    const mounts = composeBindMounts(fs.readFileSync(full, "utf8"));
    const missing = [];
    for (const mount of mounts) {
      const source = mount.startsWith("~/") ? path.join(os.homedir(), mount.slice(2)) : path.resolve(path.dirname(full), mount);
      if (!fs.existsSync(source)) missing.push(mount);
    }
    if (missing.length) throw preflightError("COMPOSE_MOUNT_MISSING", `Compose bind mounts do not exist (${relative}): ${missing.join(", ")}`);
    checks.push({ file: relative, mounts });
  }
  return checks;
}

export function assertPortFree(port) {
  const script = `const n=require("node:net");const s=n.createServer();s.once("error",e=>{process.stderr.write(String(e.code||e.message));process.exit(e.code==="EADDRINUSE"?1:2)});s.listen(${Number(port)},"127.0.0.1",()=>s.close(()=>process.exit(0)));`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.status === 1) throw preflightError("PORT_IN_USE", `Port ${port} is already in use`);
  if (result.status !== 0) throw preflightError("PORT_CHECK_FAILED", `Unable to check port ${port}: ${result.stderr || result.status}`);
}

export function freeDiskMb(dir) {
  if (typeof fs.statfsSync !== "function") return null;
  try {
    const stat = fs.statfsSync(dir);
    return Math.floor(Number(stat.bavail) * Number(stat.bsize) / (1024 * 1024));
  } catch { return null; }
}

function dockerLines(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function dockerResourceSnapshot() {
  try { resolveExecutable("docker", process.cwd()); }
  catch { return null; }
  const probe = spawnSync("docker", ["ps", "-aq"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (probe.status !== 0) return null;
  return {
    containers: String(probe.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    volumes: dockerLines(["volume", "ls", "-q"]),
    networks: dockerLines(["network", "ls", "-q"]),
    images: dockerLines(["images", "-q"])
  };
}

export function createdResources(before, after) {
  if (!before || !after) return { containers: [], volumes: [], networks: [], images: [] };
  const diff = (previous, next) => (next || []).filter(id => !(previous || []).includes(id));
  return {
    containers: diff(before.containers, after.containers),
    volumes: diff(before.volumes, after.volumes),
    networks: diff(before.networks, after.networks),
    images: diff(before.images, after.images)
  };
}

export function planCleanup(created, policy = {}, success = false) {
  const remove = { containers: [], networks: [], volumes: [], images: [] };
  if (policy.containers === "always") remove.containers = [...(created.containers || [])];
  if (policy.networks === "always") remove.networks = [...(created.networks || [])];
  if ((policy.volumes === "on_success" || policy.volumes === "retain_on_failure") && success) remove.volumes = [...(created.volumes || [])];
  return remove;
}

export function executeCleanup(remove = {}, jobId, runCommand = spawnSync) {
  const cleaned = [], remaining = [], errors = [];
  const run = (args, id, kind) => {
    // A global before/after inventory cannot establish ownership in a shared daemon.
    const inspectArgs = kind === "container" ? ["inspect", "--type", "container", id] : [kind, "inspect", id];
    const inspected = jobId ? runCommand("docker", inspectArgs, { encoding: "utf8", windowsHide: true, timeout: 15000 }) : { status: null };
    let owner;
    try { const resource = JSON.parse(inspected.stdout)[0]; owner = (resource.Config?.Labels || resource.Labels || {})["io.grok-safe.job-id"]; } catch {}
    if (!jobId || inspected.status !== 0 || owner !== jobId) {
      remaining.push({ kind, id });
      errors.push({ kind, id, code: "RESOURCE_OWNERSHIP_UNVERIFIED", message: "Retained resource without matching io.grok-safe.job-id label" });
      return;
    }
    const result = runCommand("docker", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (result.status === 0) cleaned.push({ kind, id });
    else { remaining.push({ kind, id }); errors.push({ kind, id, message: (result.stderr || result.stdout || "").trim().slice(0, 400) }); }
  };
  for (const id of remove.containers || []) run(["rm", "-f", id], id, "container");
  for (const id of remove.networks || []) run(["network", "rm", id], id, "network");
  for (const id of remove.volumes || []) run(["volume", "rm", id], id, "volume");
  return { cleaned, remaining, errors };
}

export function leftoverFromCreated(created, cleaned) {
  const removed = new Set((cleaned || []).map(item => `${item.kind}:${item.id}`));
  const leftover = [];
  for (const [kind, ids] of Object.entries({ container: created.containers || [], volume: created.volumes || [], network: created.networks || [], image: created.images || [] })) {
    for (const id of ids) if (!removed.has(`${kind}:${id}`)) leftover.push({ kind, id, retained: kind === "image" || kind === "volume" });
  }
  return leftover;
}

function registryConfigured() {
  const file = path.join(os.homedir(), ".docker", "config.json");
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(parsed.auths && Object.keys(parsed.auths).length) || Boolean(parsed.credHelpers && Object.keys(parsed.credHelpers).length) || Boolean(parsed.credsStore);
  } catch { return false; }
}

export function runContractPreflight(cwd, spec, capabilities = [], env = process.env) {
  const checks = { tools: {}, env: {}, ports: spec.ports || [], compose: [], diskMb: null, docker: null, registry: null };
  const tools = [...new Set([...(spec.tools || []), ...((capabilities.includes("buildImage") || capabilities.includes("push") || capabilities.includes("deploy")) ? ["docker"] : [])])];
  for (const binary of tools) checks.tools[binary] = resolveExecutable(binary, cwd, env);
  for (const name of spec.env || []) {
    if (env[name] == null || String(env[name]).trim() === "") throw preflightError("ENV_MISSING", `Required environment variable is empty: ${name}`);
    checks.env[name] = "set";
  }
  for (const port of spec.ports || []) assertPortFree(port);
  checks.compose = checkComposeFiles(cwd, spec.composeFiles || []);
  if (spec.diskMb) {
    checks.diskMb = freeDiskMb(cwd);
    if (checks.diskMb != null && checks.diskMb < spec.diskMb) throw preflightError("DISK_LOW", `Free disk ${checks.diskMb}MB is below ${spec.diskMb}MB`);
  }
  let dockerSnapshot = null;
  if (tools.includes("docker")) {
    const info = spawnSync("docker", ["info"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (info.status !== 0) throw preflightError("DOCKER_UNAVAILABLE", (info.stderr || info.stdout || "docker info failed").trim().slice(0, 400));
    checks.docker = "available";
    dockerSnapshot = dockerResourceSnapshot();
    if (spec.registry) {
      checks.registry = registryConfigured();
      if (!checks.registry) throw preflightError("REGISTRY_LOGIN_MISSING", "preflight.registry=true but no Docker registry credentials are configured");
    }
  }
  return { checks, dockerSnapshot };
}
