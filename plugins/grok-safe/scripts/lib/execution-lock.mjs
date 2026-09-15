import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function acquireExecutionLock(dir, executionPath, jobId) {
  fs.mkdirSync(dir, { recursive: true });
  const canonical = fs.realpathSync(executionPath);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const file = path.join(dir, `execution-${key}.lock`), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, jobId, token })); } finally { fs.closeSync(fd); }
      return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (attempt === 0 && owner && !processAlive(owner.pid)) { fs.unlinkSync(file); continue; }
      throw Object.assign(new Error('WORKSPACE_BUSY: execution workspace is owned by another job'), { code: 'WORKSPACE_BUSY' });
    }
  }
}
