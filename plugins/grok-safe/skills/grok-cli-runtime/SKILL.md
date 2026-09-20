---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Codex
---

# Grok Safe Runtime

Use through the Grok MCP tools. If MCP is unavailable, call the companion directly with `node plugins/grok-safe/scripts/grok-companion.mjs <command> ...`.

Use `grok_capabilities` for the installed CLI version, live models and protocol support. ACP integration has been tested with 1.0.30; never infer support from a minimum version alone.

## Workspace

Installed Codex plugin MCP servers start from the plugin cache. Pass `cwd` with the active project
directory on every Grok MCP call so Grok inspects, edits, and stores artifacts in the intended
workspace rather than the cached plugin directory. Direct companion calls can use `--cwd <path>`.

## Concurrency

- **Multiple companion jobs may run at once.** There is no global single-agent lock.
- Prefer `background: true` or `--background` when a Codex turn is launching more than one Grok job.
- Each MCP call should make exactly one companion invocation.
- Parallelism = multiple background companion jobs, not a serialized queue.
- When several jobs are running, always pass job ids to `status` / `result` / `cancel`.

## Control flags (most write/plan commands)

MCP input keys map to companion flags:

| MCP property | Companion flag |
| --- | --- |
| `sandbox` | `--sandbox` |
| `planMode` | `--plan` |
| `permissionMode` | `--permission-mode` |
| `agent` | `--agent` |
| `noSubagents` | `--no-subagents` |
| `memory` / `noMemory` | `--memory` / `--no-memory` |
| `allow` / `deny` | `--allow` / `--deny` (repeatable) |
| `disableWebSearch` | `--disable-web-search` |
| `forkSession` | `--fork-session` |
| `maxTurns` | `--max-turns` |

## CLI posture

- Write tasks use `permissionMode=dontAsk` with explicit allow rules and a workspace sandbox.
- `--yolo` / bypass-permissions are forbidden.
- Ordinary project edits and safe tests are approved by Codex through built-in allow rules.
- Sensitive files, package installation, external paths, remote effects, infrastructure tools, or
  broader permissions require explicit user approval and `sensitiveApproved=true`.
- Web search, memory, and Grok subagents are disabled by default.
- Media: no yolo / no tools allowlist.
- `--dry-run` / `--validate-only` / babysit `list`: **read-only** (no yolo).
- Write-capable operations run under Codex supervision and must be reviewed by Codex afterward.

## Depth notes

- `grok_execute_plan` with `latest=true` resolves newest `.grok-designs/*.md`.
- Design/workflow/plan/document jobs harvest copies into `.grok-designs/` / `.grok-workflows/` / `.grok-plans/` / `.grok-docs/`.
- Review `postPending=true`: skips empty findings; empty/oversize diffs fail closed and save findings under `.grok-reviews/`.
- Plan results prefer harvested `plan.md` body over narration.
- Stop-gate uses sandbox `read-only` + denylist (no yolo).

## State env

- Default job state: `~/.grok/codex-plugin/state/`
- Override: `GROK_CODEX_PLUGIN_STATE`
- Host plugin data: `CODEX_PLUGIN_DATA` only when the dir basename is trusted (`grok` / `grok-*`)
- Does **not** share Claude plugin state (`GROK_CLAUDE_PLUGIN_STATE` / `claude-plugin`)

## Verified delivery contract

For code tasks, translate user-required tests, commits, artifacts and path restrictions into the
`acceptance` MCP object (`--acceptance` JSON on the CLI). Required test commands must be supplied
as `requiredCommands`; `requireTests=true` without commands is rejected before launch. Use
`allowedPaths` for intended new files, and `forbiddenPaths` for protected scope. `requireCommit`
requires explicit narrow Git add/commit allow rules. Never substitute the model's test report
for `tests[].exitCode` or treat `processExited` as `taskCompleted`.

`check` defaults to true and invokes plugin-side delivery checks. `check=false` does not disable
explicit acceptance conditions or the requirement to produce a deliverable. `expectedChange=false`
requires an explicit verification command. Required artifacts must be fresh, nonempty workspace files.

The supported sandbox and permission enums are defined in `scripts/lib/control.mjs` and reused
by the MCP schema. Permission denial remains authoritative even with sensitive-file approval.
Use `sensitiveApprovedPaths` for exact user-approved files; `sensitiveDenyTypes` always wins.
Only public certificates and fixtures can be category-allowed. Dependency exclusions are restricted.

`worktree=false` is honored. Named worktrees and multi-candidate `bestOfN` are rejected; dispatch
separate supervised jobs instead. Resume keeps the previous workspace and acceptance contract;
do not pass replacement worktree/check/acceptance options. `RESUME_CONTEXT_LOST` means recovery
is unavailable, not that a fresh execution succeeded. Empty failed worktrees may be cleaned up;
successful and dirty worktrees are preserved. Use `list_worktrees`, `retain_worktree(jobId)` and
`cleanup_worktree(jobId)` for lifecycle management.

Explicit turn events enable narration metrics and stall detection. Without those events, counters
are not inferred from text chunks. Heartbeats are supervision events (phase, currentAction,
lastActivityAt). The 180-second write watchdog stalls only when there is no active tool and no
Git change. A watchdog warning is logged; the runtime does not inject system messages into a
running Grok session.

Default `acceptance.capabilities` are `read`, `edit`, and `test`. Add `buildImage` for local
Docker compose/build, and `push`/`deploy` only with `sensitiveApproved=true` plus
`publish.images` (immutable tag or digest; dirty publish requires `allowDirtyPublish`).
`frozenTestGlobs` freeze oracle/test hashes; changes need `oracleChangeReasons` and are listed
with diffs. Optional `preflight` checks only declared tools/env/ports/composeFiles — never
hard-code a language or product. Optional `stage` + `requires` gate a pipeline across jobs.
`cleanupPolicy` applies only to Docker resources created after the job's preflight snapshot.
Delivery reports land in `artifacts/<jobId>/manifest.json` with SHA-256. Do not treat a raw
failed-test count as independent product defects; read `testSummary` and `failureType`.

## Task (`grok_rescue`)

- Exactly one `task` invocation per handoff
- ACP aliases `fast` / `deep` use the current advertised model with supported low / high effort.
- Query `grok_capabilities` for exact model IDs and effort choices; do not hard-code old model IDs.
- `resume` → `--resume-last`; `resumeSession` → resume that id; `fresh` → no resume
- Preserve explicit `worktree=false` and `check=false`. Named worktrees and bestOfN>1 currently return explicit unsupported-option errors.
- Default write-capable; `readOnly` only when requested

## Plan (`grok_plan`)

- Forces plan permission mode; harvests `.grok-plans/`

## Review (`grok_review` / `grok_adversarial_review`)

- Read-only; never apply patches
- `postPending` + `pr` posts a GitHub PENDING review

## Workflow / design / execute / babysit / document / sessions

- `grok_workflow` — `action=list|run`; list and `validateOnly` are read-only
- `grok_design` — design-doc writer/reviewer loop
- `grok_execute_plan` — PR Plan DAG; `dryRun` is read-only
- `grok_babysit` — `action=add|list|check|remove`; list is read-only
- `grok_document` — `type=pptx|pdf|docx`
- `grok_sessions` — `action=list|search|export`

## Media (`grok_image` / `grok_video`)

- Artifacts under `.grok-media/image/` and `.grok-media/video/`

## Jobs

- `grok_status` / `grok_result` / `grok_cancel`
- Status shows accumulated stream progress (text + thought tails); whitespace-only stays `running`
- Result includes usage and artifacts when present

## Persistent ACP supervision

Before dispatch, the runtime checks the verifier and actual command environment. Read the returned
baseline warning: an isolated worktree starts from a commit and does not include uncommitted source
changes. Keep tasks independently verifiable; large-handoff warnings are heuristic and do not replace
Codex's responsibility to split scope. The default limit is three active jobs per MCP server.

Prefer `grok_wait_many` with 1–8 `{jobId,cursor}` targets when supervising several jobs. Preserve
each cursor, drain `hasMore`, and read referenced evidence before making the corresponding decision.
`round`, `replayed` and `eventSource` distinguish execution rounds from historical snapshots.
Disconnected/interrupted jobs require explicit recovery; do not busy-poll them as live tasks.

Use `grok_retry_verification` on a stopped job after repairing verification infrastructure. It runs
the original acceptance commands without another model call. Check implementationStatus,
artifactStatus, testStatus and infrastructureErrors independently; reviewStatus=pending still
requires full Codex review. No tool in this flow approves or merges the result.

Messages advance received → delivered → acknowledged. Acknowledgment means the prompt returned,
not that the requested change passed acceptance. `interrupt-stopped` confirms the previous prompt
returned. During verification, cancellation waits for the bounded test process; never claim that
all test subprocesses stopped immediately. Null turn metrics mean unobserved, not zero work.

`grok_rescue` defaults to ACP. `grok_run` accepts a general prompt and kind, including document,
image, video, design and workflow. Use exact `acceptance.requiredArtifacts` for file deliverables.
The generic route uses the CLI agent; specialized media/workflow tools keep their own native pipeline.
Use `transport=headless` on rescue only for compatibility; it does not provide native live controls.

- Start with `background=true`; retain the job ID and cursor.
- `grok_wait(jobId,cursor,timeoutMs=60000)` defaults to compact supervision events. Always reuse
  the returned cursor, including on `grok_status` and `grok_result`, to avoid replay. Routine
  text/thought/tool telemetry stays on disk and does not wake Codex; heartbeats, failures, permission
  denials, phase changes, watchdog warnings, acceptance retries and control receipts remain visible.
- `detail=full` on wait/events/status/result retrieves raw events and complete stored output.
  Compact responses include `evidenceFile` and `eventsFile` for full local inspection; `gap=true`
  requires reading missed evidence from the event file before accepting the job. Successful test
  logs are omitted from summaries; commands, exit codes, failure logs and changed paths remain.
  Read truncated result text from the evidence file when needed. This only compresses reporting:
  Codex must still review the complete diff, untracked files and verification evidence after writes.
- `grok_send(jobId,text,delivery=steer|interrupt|queue,messageId)` returns receipt first.
  Watch `message-delivered` for delivery. Steer waits for a native post-tool/stop boundary;
  interrupt cancels the active prompt and sends a replacement in the same session; queue starts next.
- `grok_session_config` changes model or effort through the native session interface.
- Reuse `resumeSession`; the runtime preserves baseline and worktree and reuses a warm connection
  when available. Closed connections load the recorded session. Missing context fails explicitly.
- Verification runs in a separate process, so waiting/checking other jobs remains responsive.
- A native post-tool hook does not support replacing tool output. Do not claim a hash cache saved
  model input tokens when no actual replacement occurred.

## CLI updates and command discovery

Call `grok_cli_update(action=configure,mode=auto-stable,intervalMinutes=5)` when automatic stable
updates are requested. Modes: off, check (default, 15 minutes), auto-stable. Checks run at MCP
startup and on the configured interval while the server lives. An inactive server cannot monitor.
`action=check` is read-only; `action=install` requests an idle stable update.

Updates use native `grok update --check --json` and `grok update --stable`. Busy jobs defer installs;
warm idle agents close first, a Windows process check detects other Grok runners, and an update lock
serializes installers. No available update means no reinstall. Native version/help is refreshed
after install; missing required interfaces return an incompatible result rather than success.

`grok_capabilities` lists version-matched commands and live model/effort metadata.
`grok_cli_help(command="agent stdio")` returns exact native help. Never guess flags from old examples.
Manual/external binary replacement invalidates the help cache on the next invocation.
