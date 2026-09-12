import fs from "node:fs";
import path from "node:path";

import { resolveGrokBinary } from "./grok.mjs";
import { runCommand } from "./process.mjs";
import { encodeGrokSessionWorkspaceKey, resolveGrokSessionsRoot } from "./media.mjs";

/**
 * List sessions for cwd via `grok sessions list` with filesystem fallback.
 */
export function listSessions({ cwd, limit = 20 } = {}) {
  const binary = resolveGrokBinary();
  if (binary) {
    const result = runCommand(binary, ["sessions", "list"], {
      cwd,
      maxBuffer: 4 * 1024 * 1024
    });
    if (result.status === 0 && String(result.stdout || "").trim()) {
      const parsed = parseSessionsCliOutput(result.stdout);
      if (parsed.length) {
        return parsed.slice(0, limit);
      }
    }
  }
  return listSessionsFromFilesystem(cwd, limit);
}

export function searchSessions({ cwd, query, limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) {
    throw new Error("sessions search requires a query");
  }
  const binary = resolveGrokBinary();
  if (binary) {
    const result = runCommand(binary, ["sessions", "search", q], {
      cwd,
      maxBuffer: 4 * 1024 * 1024
    });
    if (result.status === 0 && String(result.stdout || "").trim()) {
      const parsed = parseSessionsCliOutput(result.stdout);
      if (parsed.length) {
        return parsed.slice(0, limit);
      }
    }
  }
  // Fallback: filter filesystem list
  const all = listSessionsFromFilesystem(cwd, 100);
  const lower = q.toLowerCase();
  return all
    .filter(
      (s) =>
        (s.id && s.id.toLowerCase().includes(lower)) ||
        (s.title && s.title.toLowerCase().includes(lower))
    )
    .slice(0, limit);
}

/**
 * Export session transcript via `grok export`.
 */
export function exportSession(sessionId, { outputPath = null, cwd = process.cwd() } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw new Error("session id is required");
  }
  const binary = resolveGrokBinary();
  if (!binary) {
    throw new Error("Grok CLI not found; cannot export session");
  }
  const args = ["export", id];
  if (outputPath) {
    args.push(outputPath);
  }
  const result = runCommand(binary, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const err = String(result.stderr || result.stdout || "export failed").trim();
    throw new Error(err || `grok export failed with code ${result.status}`);
  }
  return {
    sessionId: id,
    outputPath: outputPath || null,
    markdown: outputPath ? null : String(result.stdout || ""),
    ok: true
  };
}

export function parseSessionsCliOutput(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sessions = [];
  // UUID-ish lines or "id  title" patterns
  const uuidRe =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b(.*)$/i;
  for (const line of lines) {
    const m = line.match(uuidRe);
    if (m) {
      sessions.push({
        id: m[1],
        title: m[2].replace(/^[\s|:-]+/, "").trim() || null
      });
      continue;
    }
    // JSON lines
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        if (obj.id || obj.sessionId) {
          sessions.push({
            id: obj.id || obj.sessionId,
            title: obj.title || obj.name || null
          });
        }
      } catch {
        // ignore
      }
    }
  }
  return sessions;
}

function listSessionsFromFilesystem(cwd, limit) {
  try {
    const key = encodeGrokSessionWorkspaceKey(cwd);
    const root = path.join(resolveGrokSessionsRoot(), key);
    if (!fs.existsSync(root)) {
      return [];
    }
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(root, e.name);
        let mtime = 0;
        let title = null;
        try {
          mtime = fs.statSync(dir).mtimeMs;
        } catch {
          // ignore
        }
        // optional meta
        for (const metaName of ["meta.json", "session.json", "title.txt"]) {
          const metaPath = path.join(dir, metaName);
          if (!fs.existsSync(metaPath)) continue;
          try {
            if (metaName.endsWith(".json")) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
              title = meta.title || meta.name || title;
            } else {
              title = fs.readFileSync(metaPath, "utf8").trim() || title;
            }
          } catch {
            // ignore
          }
        }
        return { id: e.name, title, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(({ id, title }) => ({ id, title }));
    return entries;
  } catch {
    return [];
  }
}
