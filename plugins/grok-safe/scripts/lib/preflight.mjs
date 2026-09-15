import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { splitRawArgumentString } from './args.mjs';

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
  const installation = checkedInstallation || verifyInstallation(entry);
  const commands = (acceptance.requiredCommands || []).map(command => resolveVerificationCommand(command, cwd));
  const interpreters = {};
  for (const binary of ['node', 'python', 'python3', 'git']) { try { interpreters[binary] = resolveExecutable(binary, cwd); } catch {} }
  if (checkWritable && control.sandbox !== 'read-only') {
    const probe = path.join(cwd, `.grok-write-probe-${randomUUID()}`);
    try { fs.writeFileSync(probe, '', { flag: 'wx' }); fs.unlinkSync(probe); }
    catch (error) { throw preflightError('WORKSPACE_NOT_WRITABLE', error.message); }
  }
  return { installation, commands, interpreters, cwd, temporaryDirectory: os.tmpdir(),
    temporaryDirectoryPolicy: 'Interpreter-managed temporary files only; direct file tools remain workspace-scoped.',
    dependencyCoverage: 'Verifier imports and command executables checked; project test dependencies are verified when the exact test commands run.',
    capabilities: { allow: control.allow, deny: control.deny,
    sandbox: control.sandbox, web: !control.disableWebSearch, subagents: !control.noSubagents,
    note: 'Visible native tools are subject to these rules and workspace/sensitive-file checks; denied commands must not be retried under aliases.' } };
}
