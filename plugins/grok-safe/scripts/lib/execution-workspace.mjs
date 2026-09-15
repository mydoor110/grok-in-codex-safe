import fs from "node:fs";
import path from "node:path";
import { gitEvidence, snapshotWorkspace } from "./acceptance.mjs";

export function prepareExecutionWorkspace({ cwd, jobId, jobsDir, write, worktree, worktreeRef, previous, acceptance = {} }) {
  if (previous) {
    const executionPath = previous.executionPath;
    if (!executionPath || !fs.existsSync(executionPath) || !previous.baseCommit || !previous.initialSnapshot) {
      throw new Error("RESUME_CONTEXT_LOST: original execution workspace or baseline is unavailable");
    }
    const canonical = fs.realpathSync(executionPath);
    if (fs.realpathSync(gitEvidence(executionPath, ["rev-parse", "--show-toplevel"]).trim()) !== canonical) throw new Error("RESUME_CONTEXT_LOST: original worktree registration is missing");
    if (fs.realpathSync(gitEvidence(executionPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()) !==
        fs.realpathSync(gitEvidence(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) throw new Error("RESUME_CONTEXT_LOST: repository identity changed");
    gitEvidence(executionPath, ["cat-file", "-e", `${previous.baseCommit}^{commit}`]);
    const current = snapshotWorkspace(executionPath, previous.acceptance?.requiredArtifacts || []);
    if (previous.finalHead && current.head !== previous.finalHead) throw new Error("RESUME_CONTEXT_LOST: HEAD changed since the previous attempt");
    if (previous.finalSnapshot && JSON.stringify(current) !== JSON.stringify(previous.finalSnapshot)) throw new Error("RESUME_CONTEXT_LOST: workspace changed since the previous attempt");
    return { executionPath, workspaceOwnerId: previous.workspaceOwnerId || previous.id, workspaceMode: previous.workspaceMode, baseCommit: previous.baseCommit,
      initialSnapshot: previous.initialSnapshot, acceptance: previous.acceptance,
      resumeMode: "same-session", originalSessionId: previous.grokSessionId, sameWorktree: true, sameBaseCommit: true };
  }
  if (worktreeRef && !worktree) throw new Error("INVALID_WORKSPACE_OPTIONS: worktreeRef requires worktree=true");
  const baseCommit = gitEvidence(cwd, ["rev-parse", "--verify", `${worktreeRef || "HEAD"}^{commit}`]).trim();
  let executionPath = cwd;
  if (write && worktree) {
    executionPath = path.join(jobsDir, `${jobId}.worktree`);
    gitEvidence(cwd, ["worktree", "add", "--detach", executionPath, baseCommit]);
  }
  const sourceDirty = Boolean(gitEvidence(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']).trim());
  return { executionPath, baseCommit, sourceDirty, startingState: write && worktree ? 'committed-ref' : 'working-directory',
    ...(sourceDirty && write && worktree ? { baselineWarning: 'Uncommitted source changes are not included in this isolated worktree. Split or commit prerequisite changes before delegating dependent work.' } : {}),
    initialSnapshot: snapshotWorkspace(executionPath, acceptance.requiredArtifacts || []),
    workspaceMode: !write ? "read-only-workspace" : worktree ? "managed-worktree" : "existing-worktree" };
}

export function cleanupExecutionWorkspace(job, jobsDir, relatedJobs = []) {
  if (job.workspaceMode !== "managed-worktree") throw new Error("Only plugin-managed worktrees may be cleaned up");
  if (job.retained) throw new Error("Worktree is explicitly retained");
  if (job.status === "running" || relatedJobs.some(j => j.executionPath === job.executionPath && (j.status === "running" || j.retained))) throw new Error("Worktree has an active or retained job");
  const expected = path.resolve(jobsDir, `${job.workspaceOwnerId || job.id}.worktree`);
  const actual = path.resolve(job.executionPath);
  if (actual !== expected || path.dirname(actual) !== path.resolve(jobsDir)) throw new Error("Worktree ownership check failed");
  if (!fs.existsSync(actual)) return { cleaned: true, alreadyAbsent: true };
  if (fs.realpathSync(actual) !== actual) throw new Error("Worktree path is redirected");
  const current = snapshotWorkspace(actual);
  if (current.status) throw new Error("Worktree contains uncommitted changes");
  if (gitEvidence(actual, ["ls-files", "--others", "--ignored", "--exclude-standard"]).trim()) throw new Error("Worktree contains ignored files; preserve or remove them explicitly before cleanup");
  const refs = gitEvidence(job.workspaceRoot, ["for-each-ref", `--contains=${current.head}`, "--format=%(refname)", "refs/heads", "refs/remotes"]);
  if (!refs.trim()) throw new Error("Result commit is not reachable from a repository branch");
  gitEvidence(job.workspaceRoot, ["worktree", "remove", actual]);
  return { cleaned: true, worktreePath: actual };
}
