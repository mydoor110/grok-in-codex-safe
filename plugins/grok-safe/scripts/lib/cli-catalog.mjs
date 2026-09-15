import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveGrokBinary } from "./grok.mjs";
import { resolvePluginStateRoot } from "./jobs.mjs";
import { sanitizedEnvironment } from "../../mcp/security.mjs";
import { AcpClient } from "./acp-client.mjs";

export function executeCli(binary, args, { cwd, timeoutMs = 30000, env = sanitizedEnvironment() } = {}) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString(); let stdout = "", stderr = "", settled = false;
    const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve({ args, stdout, stderr, startedAt, finishedAt: new Date().toISOString(), ...result }); };
    const timer = setTimeout(() => { child.kill(); finish({ exitCode: null, error: "timeout" }); }, timeoutMs);
    child.stdout.on("data", d => { stdout = (stdout + d.toString()).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", d => { stderr = (stderr + d.toString()).slice(-65536); });
    child.on("error", e => finish({ exitCode: null, error: e.message }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

export function parseCliHelp(text) {
  const commands = [], flags = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^(Commands|Options):/.test(line)) section = line.trim();
    if (section === "Commands:") {
      const m = line.match(/^  ([a-z][a-z0-9-]*)\s{2,}(.*)$/);
      if (m && m[1] !== "help") commands.push({ name: m[1], description: m[2] });
    }
    if (section === "Options:") {
      for (const match of line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) if (!flags.includes(match[1])) flags.push(match[1]);
    }
  }
  return { commands, flags };
}

export class CliCatalog {
  constructor({ stateRoot = resolvePluginStateRoot(), binary, run = executeCli, isBusy = () => false, onChange = () => {}, beforeUpdate = async () => {}, externalBusy = async () => {
    if (process.platform !== "win32") return false;
    const result = await executeCli("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-Process -Name grok -ErrorAction SilentlyContinue).Count"]);
    return result.exitCode !== 0 || Number(result.stdout.trim()) > 0;
  } } = {}) {
    this.dir = path.join(stateRoot, "cli-catalog"); this.file = path.join(this.dir, "catalog.json");
    this.policyFile = path.join(this.dir, "update-policy.json");
    this.beforeUpdate = beforeUpdate; this.externalBusy = externalBusy;
    this.binary = binary; this.run = run; this.isBusy = isBusy; this.onChange = onChange; this.pending = null; this.updating = false;
    try { this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.cache = null; }
    try { this.policy = JSON.parse(fs.readFileSync(this.policyFile, "utf8")); } catch { this.policy = { mode: "check", intervalMinutes: 15 }; }
  }
  resolveBinary() { const binary = this.binary || resolveGrokBinary(); if (!binary) throw new Error("Grok CLI is not installed"); return binary; }
  fingerprint(binary) { const s = fs.statSync(binary); return `${binary}:${s.size}:${s.mtimeMs}`; }
  async refresh(force = false, minimal = false) {
    const binary = this.resolveBinary(), fingerprint = this.fingerprint(binary);
    if (!force && this.cache?.fingerprint === fingerprint && (minimal || !this.cache.partial)) return this.cache;
    if (this.pending) { await this.pending; return this.refresh(false, minimal); }
    this.pending = this.collect(binary, fingerprint, minimal).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(binary, fingerprint, minimal = false) {
    const [version, help] = await Promise.all([this.run(binary, ["version"]), this.run(binary, ["--help"])]);
    if (version.exitCode !== 0 || help.exitCode !== 0) throw new Error("CLI compatibility probe failed");
    const root = parseCliHelp(help.stdout), pages = { "": { ...root, help: help.stdout } };
    const queue = root.commands.filter(c => !minimal || ['agent', 'update'].includes(c.name)).map(c => [c.name]);
    // Bound process fan-out while keeping independent help calls concurrent.
    for (let i = 0; i < queue.length;) {
      const batch = queue.slice(i, i + 4);
      i += batch.length;
      await Promise.all(batch.map(async command => {
        const r = await this.run(binary, [...command, "--help"], { timeoutMs: 10000 });
        if (r.exitCode !== 0) return;
        const page = parseCliHelp(r.stdout); pages[command.join(" ")] = { ...page, help: r.stdout };
        if (command.length < 2) for (const child of page.commands) if (!minimal || child.name === 'stdio') queue.push([...command, child.name]);
      }));
    }
    const previous = this.cache;
    const digest = createHash("sha256").update(JSON.stringify(pages)).digest("hex");
    this.cache = { binary, fingerprint, partial: minimal, version: version.stdout.trim(), capturedAt: new Date().toISOString(), digest,
      acp: Boolean(pages["agent stdio"]), pages, changed: previous?.digest !== digest,
      removedCommands: previous ? Object.keys(previous.pages).filter(k => !pages[k]) : [],
      addedCommands: previous ? Object.keys(pages).filter(k => !previous.pages[k]) : Object.keys(pages) };
    fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    if (this.cache.changed) this.onChange({ type: "cli-capabilities-changed", version: this.cache.version });
    return this.cache;
  }
  async help(command = "") {
    const catalog = await this.refresh();
    if (!Object.hasOwn(catalog.pages, command)) throw new Error(`Command is not advertised by the installed CLI: ${command}`);
    return { version: catalog.version, capturedAt: catalog.capturedAt, command, ...catalog.pages[command] };
  }
  async protocolCapabilities() {
    const catalog = await this.refresh(false, true);
    if (!catalog.acp) return { available: false };
    if (this.protocolCache?.fingerprint === catalog.fingerprint) return this.protocolCache;
    const client = new AcpClient(catalog.binary, ["agent", "--no-leader", "stdio"], { env: sanitizedEnvironment() });
    try {
      const result = await client.initialize();
      this.protocolCache = { fingerprint: catalog.fingerprint, available: true, agentCapabilities: result.agentCapabilities,
        models: result._meta?.modelState, slashCommands: result._meta?.availableCommands || [], capturedAt: new Date().toISOString() };
      return this.protocolCache;
    } finally { client.close(); }
  }
  configure({ mode = this.policy.mode, intervalMinutes = this.policy.intervalMinutes } = {}) {
    if (!["off", "check", "auto-stable"].includes(mode) || !Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) throw new Error("Invalid update policy");
    this.policy = { mode, intervalMinutes }; fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.policyFile, JSON.stringify(this.policy)); this.startMonitor(); return this.policy;
  }
  async checkUpdate({ install = false } = {}) {
    if (this.updating) return { status: "update-in-progress" };
    const catalog = await this.refresh(false, true);
    if (!catalog.pages.update?.flags.includes("--check")) return { status: "unsupported", version: catalog.version };
    if (!catalog.pages.update.flags.includes("--json")) return { status: "unsupported", reason: "Native JSON update status is unavailable" };
    const result = await this.run(catalog.binary, ["update", "--check", "--json"]);
    let update; try { update = JSON.parse(result.stdout); } catch { update = null; }
    const report = { checkedAt: result.finishedAt, currentVersion: catalog.version, exitCode: result.exitCode, update, error: result.error || (result.exitCode !== 0 ? result.stderr : null) };
    fs.mkdirSync(this.dir, { recursive: true });
    const previousLatest = this.lastUpdate?.update?.latestVersion;
    this.lastUpdate = report; fs.writeFileSync(path.join(this.dir, "last-update.json"), JSON.stringify(report, null, 2));
    if (update?.updateAvailable === true && update.latestVersion !== previousLatest) this.onChange({ type: "cli-update-available", ...report });
    if (!install || result.exitCode !== 0 || update?.error) return report;
    if (update?.updateAvailable === false) return { ...report, status: "up-to-date" };
    if (update?.updateAvailable !== true) return { ...report, status: "unknown", error: "Native update availability could not be verified" };
    if (this.isBusy()) return { ...report, deferred: true, reason: "Active Grok jobs must finish before updating" };
    let lock;
    const lockPath = path.join(this.dir, "update.lock");
    try { lock = fs.openSync(lockPath, "wx"); fs.writeFileSync(lock, String(process.pid)); }
    catch {
      // A killed updater must not leave automatic updates permanently disabled.
      try {
        const owner = Number(fs.readFileSync(lockPath, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (error) { if (error.code === "ESRCH") { fs.unlinkSync(lockPath); return this.checkUpdate({ install }); } }
        }
      } catch {}
      return { ...report, deferred: true, reason: "Another updater holds the update lock" };
    }
    this.updating = true;
    try {
      await this.beforeUpdate();
      if (this.isBusy() || await this.externalBusy()) return { ...report, deferred: true, reason: "A Grok process is still active" };
      if (!catalog.pages.update.flags.includes("--stable")) return { ...report, status: "unsupported", error: "Stable channel selection is unavailable" };
      const installed = await this.run(catalog.binary, ["update", "--stable"], { timeoutMs: 180000 });
      const refreshed = await this.refresh(true);
      let handshake, compatibilityError;
      try {
        this.protocolCache = null;
        handshake = await this.protocolCapabilities();
      } catch (error) { compatibilityError = error.message; }
      const compatible = Boolean(refreshed.acp && handshake?.available && handshake.agentCapabilities?._meta?.['x.ai/hooks']);
      const outcome = { ...report, installExitCode: installed.exitCode, installedVersion: refreshed.version, compatible,
        status: installed.exitCode === 0 && compatible ? "updated" : "update-failed", error: installed.error || compatibilityError || (installed.exitCode ? installed.stderr : !compatible ? 'Required supervision handshake unavailable; restore a known compatible CLI before dispatch' : null),
        rollback: 'not-performed', recoveryRequired: !compatible };
      this.onChange({ type: outcome.status, ...outcome }); return outcome;
    } finally { this.updating = false; fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
  startMonitor() {
    clearInterval(this.timer);
    this.closed = false;
    if (this.policy.mode === "off") return;
    const tick = () => {
      if (this.closed || this.checking || this.policy.mode === "off") return;
      this.checking = this.checkUpdate({ install: this.policy.mode === "auto-stable" }).catch(error => { this.lastUpdate = { error: error.message }; }).finally(() => { this.checking = null; });
    };
    this.timer = setInterval(tick, this.policy.intervalMinutes * 60000);
    queueMicrotask(tick);
    this.timer.unref();
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
