import path from "node:path";
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return path.resolve(ensureGitRepository(cwd));
  } catch {
    return cwd;
  }
}
