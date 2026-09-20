# Grok Safe security model

This independent derivative of [stdevMac/grok-in-codex](https://github.com/stdevMac/grok-in-codex) v0.5.8 makes Codex the supervisor and Grok the implementation worker. It is not an official grok-in-codex release.

## Default behavior

- Grok may edit files inside an isolated Git worktree without interrupting the user.
- The Grok CLI runs with the `workspace` sandbox and `dontAsk` permissions.
- Only explicit file tools and routine local inspection/test commands are allowed.
- `--yolo`, bypass-permissions, web search, memory, and Grok subagents are disabled.
- Child processes receive a minimal environment; unrelated cloud and GitHub tokens are removed.
- File arguments must remain inside the canonical active Git repository.
- Sensitive filenames are detected before delegation.
- GitHub writes, package installation, network/download tools, infrastructure CLIs, destructive
  commands, secrets, and broad allow rules require explicit user approval.
- Acceptance capabilities are a ladder: `read` → `edit` → `test` → `buildImage` → `push` → `deploy`.
  Docker compose/build is not Docker push. Push and deploy also need `sensitiveApproved` and a
  target preview; dirty worktrees cannot be published unless `allowDirtyPublish` is set.

## Approval contract

Codex may set `sensitiveApproved=true` only after the user explicitly approves the specific
sensitive access or elevated effect. The flag does not grant anything by itself: Codex must also
pass the narrowest required allow rule.

## Review contract

Codex must review the complete diff and untracked files and run appropriate verification after
every Grok write task. Grok cannot merge, push, publish, or approve its own output.

## Remaining boundary

Repository content sent to Grok is processed by xAI. Local sandboxing cannot replace xAI account
privacy settings or Zero Data Retention. A determined compromise of the Grok CLI itself is also
outside this JavaScript wrapper's security boundary.
