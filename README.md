# Grok Safe for Codex

> Independent, unofficial derivative of [stdevMac/grok-in-codex](https://github.com/stdevMac/grok-in-codex) **v0.5.8** (Apache-2.0).  
> 本仓库是 grok-in-codex 的独立非官方衍生版本，不是原作者发布或维护的项目。详见 [Origin and attribution](#origin-and-attribution)。

Use [Grok](https://grok.com) as a Codex-supervised implementation worker. Codex remains the primary agent, delegates bounded tasks, and independently reviews Grok's changes.

**Plugin version:** 0.5.8-safe.1, based on [grok-in-codex](https://github.com/stdevMac/grok-in-codex) 0.5.8. A thin MCP server + companion script hands work to the local Grok Build CLI (≥ **0.2.118** recommended).

Routine project edits do not interrupt the user. They run in a Git worktree with fail-closed
permissions. Sensitive files, project-external paths, package installation, remote mutations,
infrastructure tools, and broader permissions must be escalated by Codex for explicit user approval.
See [SECURITY.md](SECURITY.md).

Artifact dirs (gitignored): `.grok-plans/`, `.grok-designs/`, `.grok-workflows/`, `.grok-docs/`, `.grok-reviews/`, `.grok-media/`.

The original author's Claude Code plugin is [grok-in-claude](https://github.com/stdevMac/grok-in-claude). That project is unrelated to this derivative.

## Verified code delivery

ACP reliability updates add installation/environment preflight, separate implementation/test/review
states, verification-only retry, bounded multi-job waits and durable workspace ownership.
See [reliability and supervision](docs/reliability-and-supervision.md) for exact behavior and limits.

Code tasks now use plugin-side acceptance instead of treating a successful process exit as a completed task.
Pass `acceptance` with exact paths, verification commands, commit and artifact requirements.
ACP jobs use incremental decision events, per-round usage ledgers, soft/hard token limits and a
cancellable FIFO queue above the three-job active limit. Compact responses expose response bytes
and decision wakeups as proxy metrics because the host does not expose Codex token accounting.
Default capabilities stop at local verify; `buildImage` / `push` / `deploy` are explicit, and
`publish.images` plus a clean worktree (or `allowDirtyPublish`) are required before a remote push.
Optional `preflight`, `stage`/`requires`, `cleanupPolicy`, and `artifacts/<jobId>/` reports are
generic contract fields, not per-project hooks.
Downstream stage gates validate the delivery manifest and require a `grok_record_review` approval
whose diff and source-tree hashes still match the verified result.
See [the contract and issue-by-issue coverage](docs/verified-delivery.md) for examples, compatibility changes,
and the remaining runner-dependent limitations. Explicit `worktree=false` is honored; resume reuses
and validates the original workspace. `list_worktrees`, `retain_worktree`, and `cleanup_worktree`
manage plugin-owned worktrees conservatively.

## What you get

| Codex MCP tool | Purpose |
| --- | --- |
| `grok_setup` | Check CLI + auth + version floor + doctor; toggle stop review gate |
| `grok_rescue` | Delegate investigation / fixes (write-capable; full control flags) |
| `grok_plan` | Plan mode only (explore → plan.md under `.grok-plans/`) |
| `grok_review` | Structured read-only review (tree / branch / PR; optional `postPending`) |
| `grok_adversarial_review` | Challenge design, tradeoffs, and assumptions |
| `grok_workflow` | List/run Grok Rhai multi-agent workflows |
| `grok_design` | Design doc + PR plan (writer/reviewer loop → `.grok-designs/`) |
| `grok_execute_plan` | Execute a design-doc PR Plan DAG |
| `grok_babysit` | Watch PRs / fix CI & review comments (`list` is read-only) |
| `grok_document` | Generate docx / pdf / pptx → `.grok-docs/` |
| `grok_image` | Generate or edit images → `.grok-media/image/` |
| `grok_video` | Generate short videos → `.grok-media/video/` |
| `grok_sessions` | List / search / export Grok sessions |
| `grok_transfer` | Build context-transfer guidance for Grok |
| `grok_status` | Jobs + live progress / log tail + usage when available |
| `grok_result` | Final output (plan.md preferred for plan jobs; usage + artifacts) |
| `grok_cancel` | Cancel a background job |
| `grok_record_review` | Persist Codex's review decision, bound to verified source hashes |

**Control flags** (rescue/plan/review and long-running jobs): `sandbox`, `planMode` / `permissionMode`, `agent`, `noSubagents`, `memory` / `noMemory`, `allow` / `deny`, `disableWebSearch`, `forkSession`, `maxTurns`.

Skills: brand/media recipes, routing (including plan→design→execute-plan), runtime contracts, workflows, prompting.

## Requirements

- **Node.js 18.18 or later**
- **[Grok Build CLI](https://grok.com)** (`grok`) on your `PATH`
- **Grok authentication** (`grok login`)
- **GitHub CLI (`gh`)** only if you use `grok_review` with PRs or post-pending

Typical CLI location: `~/.grok/bin/grok` (ensure it is on `PATH`).

## Install

From GitHub (this derivative, not the original plugin):

```bash
codex plugin marketplace add mydoor110/grok-in-codex-safe
codex plugin add grok-safe@grok-safe-local
```

From a local checkout:

```bash
codex plugin marketplace add /path/to/grok-in-codex-safe/.agents/plugins
codex plugin add grok-safe@grok-safe-local
```

Then start a new Codex thread so the plugin skills and MCP tools are loaded.

Run setup:

```bash
node plugins/grok-safe/scripts/grok-companion.mjs setup
```

Or ask Codex to call `grok_setup`.

## Quick start

```text
Ask Grok to review this branch against main.
Use Grok to plan the auth rewrite.
Generate a design doc with Grok, then execute the latest plan dry-run.
Start a background Grok rescue job for the retry redesign.
Generate a 16:9 launch banner with Grok.
Show Grok job status.
```

Direct MCP tool examples:

```text
grok_plan prompt="plan the auth rewrite" background=true
grok_design prompt="design multi-tenant billing" background=true
grok_execute_plan latest=true dryRun=true
grok_workflow action=list
grok_review base=main focus="auth, data loss, and race conditions"
grok_rescue prompt="investigate why npm test is failing" background=true
grok_babysit action=list
grok_document type=pdf prompt="one-pager for the launch"
grok_sessions action=list
grok_status
grok_result jobId="plan-abc123"
grok_image aspect="16:9" prompt="Dark developer-tool launch banner"
grok_video image="./.grok-media/image/hero.png" duration="6" prompt="gentle camera push-in"
```

### Workspace selection

Codex starts an installed plugin MCP server from the plugin cache, so pass the active project
directory as `cwd` when calling a Grok tool from an installed plugin. The companion then runs in
that directory and keeps jobs, git inspection, and artifacts scoped to the intended workspace.

For direct local calls, use for example:

```text
grok_review cwd="/path/to/project" base=main
grok_status cwd="/path/to/project" json=true
```

## Depth pipeline

For multi-PR or ambiguous product work, prefer:

1. **`grok_plan`** — explore + harvest `plan.md`
2. **`grok_design`** — design doc + PR plan under `.grok-designs/`
3. **`grok_execute_plan`** with `latest=true` — implement the PR DAG
4. **`grok_review`** / **`grok_babysit`** — quality and CI loop

## Job control semantics

- **Concurrent multi-job support** — no single-job global lock. Prefer `background=true` for long work.
- **Status** — live progress is a tail of accumulated text *and* thought streams plus structured
  heartbeats (`phase`, `currentAction`, `lastActivityAt`); empty/whitespace-only stream tokens floor to `running`.
- **Result** — plan jobs prefer harvested `plan.md` body over narration; finished jobs persist `config`, `usage`, and `artifacts` (v3 schema).
- **Reaper** — dead pid + complete parseable `result.json` reconciles to completed; dead pid + empty/truncated/incomplete result → terminal **failed** with distinct diagnostics (no forever-`running` zombies).
- **Atomic writes** — background workers write `result.json` via tmp + rename (no partial mid-write; no leftover `.tmp.*` after success).
- **PR post-pending** — runs on background completion too; skips empty findings; empty/oversize diffs fail closed with recoverable findings under `.grok-reviews/`.

## CLI posture

- Write tasks use `dontAsk` with explicit safe allow rules inside the `workspace` sandbox.
- `--yolo` and bypass-permissions are forbidden.
- Web search, Grok memory, and Grok subagents are disabled by default.
- Codex must inspect the complete diff and run verification after every write task.
- Media: no yolo / no tools allowlist.
- `dryRun` / `validateOnly` / babysit `list`: **read-only** (no yolo).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override path to the `grok` CLI (also used by tests with a mock binary) |
| `GROK_CODEX_PLUGIN_STATE` | Explicit job-state root for this plugin |
| `CODEX_PLUGIN_DATA` | Host plugin data dir; trusted only when basename is `grok` / `grok-*` |

Default state root when unset: `~/.grok/codex-plugin/state/`. Codex does **not** share Claude’s `~/.grok/claude-plugin/state` or `GROK_CLAUDE_PLUGIN_STATE`.

## Usage notes

### Rescue

- Write-capable by default.
- Use `readOnly=true` for investigation-only work.
- Use `worktree=true` / `check=true`; launch separate supervised jobs for parallel candidates.
- Full control surface available (sandbox, memory, agent, allow/deny, maxTurns, …).

### Plan / design / execute

- Plan mode harvests into `.grok-plans/`; result body prefers the plan file.
- Design harvests into `.grok-designs/`.
- `grok_execute_plan` with `latest=true` picks the newest design doc; `dryRun=true` is read-only.

### Review

- Read-only; never applies patches.
- `postPending=true` with a PR posts PENDING GitHub review comments when findings exist.

### Media

- Default outputs land under `.grok-media/image/` and `.grok-media/video/`.
- Session media is copied into those dirs when Grok leaves files in its session workspace.

### Jobs

- Background tools return a job id.
- Use `grok_status` / `grok_result` / `grok_cancel` with that id when multiple jobs are active.

## Development

```bash
npm test
node plugins/grok-safe/scripts/grok-companion.mjs setup --json
node plugins/grok-safe/mcp/server.mjs   # stdio NDJSON MCP server
```

## Versioning

Root `package.json`, `plugins/grok-safe/.codex-plugin/plugin.json`, and `.agents/plugins/marketplace.json` (metadata + plugin entry) share the same version string. Bump them together.

## Origin and attribution

本仓库是 [stdevMac/grok-in-codex](https://github.com/stdevMac/grok-in-codex) **v0.5.8** 的独立衍生作品，不是 GitHub 上的官方 fork，也未经原作者或 xAI 背书。原作版权仍归原作者；本仓库只对这里列出的修改负责。

This repository is an **independent derivative** of [stdevMac/grok-in-codex](https://github.com/stdevMac/grok-in-codex) **v0.5.8**, originally written by Marcos Maceo ([stdevMac](https://github.com/stdevMac)). It keeps the Apache-2.0 license. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

| | |
| --- | --- |
| Original project | https://github.com/stdevMac/grok-in-codex |
| Original version | 0.5.8 (`8f76451`) |
| Original author | Marcos Maceo / [stdevMac](https://github.com/stdevMac) |
| Original license | Apache-2.0 |
| This repository | https://github.com/mydoor110/grok-in-codex-safe |
| This version | 0.5.8-safe.1 |

Issues and support belong here, not at the original project. Modifications may diverge from upstream and are provided **AS IS**.

### What we changed relative to grok-in-codex 0.5.8

相对上游 v0.5.8，本仓库改动如下。未列出的 MCP 能力（plan / review / design / media / docs 等）仍基于原作。

| Area | Change |
| --- | --- |
| Plugin identity | Renamed plugin `grok` → `grok-safe`; package `grok-in-codex-safe`; version `0.5.8-safe.1`. This is a separate plugin id, not a drop-in replacement of `grok@grok-in-codex`. |
| Default permissions | Fail-closed: `workspace` sandbox, `dontAsk`, no `--yolo` / bypass-permissions. Web search, Grok memory, and Grok subagents are off by default. |
| Sensitive access | Filename/content classification, per-file approval, deny-type precedence. Approving a secret no longer drops the command denylist. |
| Child environment | Unrelated cloud and GitHub tokens are stripped. File arguments must stay inside the active Git repository. |
| Delivery contract | Callers pass `acceptance` JSON. Process exit is not treated as task completion. Results include verification receipts; unmet contracts return `incomplete`. |
| Isolation | Plugin-managed Git worktrees, resume/retain/cleanup, and cross-process workspace locks. Dirty source is not copied silently into a new worktree. |
| Supervision | ACP preflight, runtime budgets, event wait / steer / interrupt, watchdog, and supervisor hooks. Codex must review the full diff after write tasks. |
| Grok CLI 1.0 | Task execution path for Grok CLI 1.0, including `task --acceptance`. |
| Installed CLI | `grok_capabilities`, `grok_cli_help`, and `grok_cli_update` read the local binary instead of assuming a fixed command surface. |
| Tests | Added acceptance, security, supervisor, reliability, watchdog, and ACP-client coverage. |
| Docs | Added [SECURITY.md](SECURITY.md), [verified-delivery](docs/verified-delivery.md), [reliability](docs/reliability-and-supervision.md), and [CLI updates](docs/cli-updates-and-coordination.md). |

Local commits on top of v0.5.8: `dca81b1` (harden as Codex-supervised worker), `2ceaaf3` (plugin cache version), `9eb0269` (Grok CLI 1.0), `02f2eda` (tests and reliability).

## License

Apache-2.0. This is a derivative work of grok-in-codex; copyright notices for the original work and these modifications are in [NOTICE](NOTICE).

### 实时协作与 CLI 更新

默认 ACP 常驻会话支持增量事件、途中纠偏、中断和恢复。新增 `grok_capabilities`、
`grok_cli_help`、`grok_cli_update` 从本机版本发现命令并检查稳定版更新。
详见 [配置和边界](docs/cli-updates-and-coordination.md)。
