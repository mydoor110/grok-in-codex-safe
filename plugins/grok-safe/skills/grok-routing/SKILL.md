---
name: grok-routing
description: When Codex should delegate to Grok vs handle work itself
user-invocable: false
---

# Codex supervisor policy

Codex is always the primary agent. Grok is a write-capable worker, never the approver.

For ordinary project-local implementation, Codex may call `grok_rescue` without asking the user.
The safe runtime uses a Git worktree, `permissionMode=dontAsk`, a workspace sandbox, explicit
allow rules, no memory, no web search, and no subagents. Pass `cwd` as the active Git repository.

Before delegation, Codex must define the requested change and may add narrowly scoped `allow`
rules for commands it independently judges safe. Never pass catch-all rules. Package installation,
remote Git/GitHub changes, cloud/infra tools, access to detected secrets, project-external paths,
or weakened sandboxing require explicit user approval. Only after receiving that approval may
Codex set `sensitiveApproved=true` and add the minimum required allow rule.

After every write-capable Grok result, Codex must independently inspect the complete Git diff,
untracked files, deletions, dependency/lockfile changes, hooks, CI files, binaries, and executable
scripts; run appropriate tests; and reject or send corrections when unsafe. Grok may not approve
its own result. Codex must not merge, push, publish, or apply remote changes merely because Grok
reported success.

# When to call Grok

## Prefer Grok MCP tools

- Substantial debugging after Codex is stuck
- Second-opinion implementation of a non-trivial change
- Best-of-N alternative approaches (`bestOfN`)
- Substantial edits that land in an isolated worktree (the safe default)
- **Ambiguous architecture** → `grok_plan` then implement, or `grok_design`
- **Multi-PR delivery from a design doc** → `grok_execute_plan`
- **Named multi-agent recipes** → `grok_workflow`
- **PR CI/review babysitting** → `grok_babysit`
- Image/video generation (`grok_image`, `grok_video`)
- Documents (`grok_document` with `type` pdf|docx|pptx)
- Structured or adversarial code review before shipping
- Long-running investigation better as a background job

## Prefer staying in Codex

- Quick questions, renames, one-line fixes
- Tiny edits with obvious answers
- Pure conversation without repo mutation

## Intent → tool

| User intent | Prefer |
| --- | --- |
| Stuck on a bug / implement a fix | `grok_rescue` (+ worktree + check) |
| Unclear approach before coding | `grok_plan` |
| Architecture / design doc + PR plan | `grok_design` |
| Ship a design doc’s PR DAG | `grok_execute_plan` (or `latest=true` after design) |
| Multi-dimension structured fan-out | `grok_workflow` |
| Ship quality on a branch/PR | `grok_review` (+ `postPending` for GH) |
| Challenge design assumptions | `grok_adversarial_review` |
| Watch / fix open PRs | `grok_babysit` |
| Deck / PDF / Word | `grok_document` |
| Brand stills / clips | `grok_image` / `grok_video` |
| Find past Grok work | `grok_sessions` |

## Depth pipeline (multi-PR / ambiguous product work)

Prefer this sequence over a single giant rescue:

1. **`grok_plan`** — explore + plan.md when the approach is unclear (artifacts under `.grok-plans/`).
2. **`grok_design`** — consensus design doc + PR Plan → artifacts under `.grok-designs/`.
3. **`grok_execute_plan`** with `latest=true` (or explicit `designDoc`) — implement the PR DAG in worktrees.
4. **`grok_review`** / **`grok_babysit`** — quality and CI/review loop.

Use **`grok_workflow`** when you have a named multi-agent recipe (fan-out review dimensions, etc.), not ad-hoc parallel rescues.

## Memory and agent profiles

- Keep memory disabled unless the user explicitly approves persistent Grok context.
- Codebase map / investigation without edits: `agent=explore` or `readOnly=true` + `sandbox=read-only`.
- Planning only: `grok_plan` or `planMode=true` on rescue.

## Parallel jobs

When workstreams are independent, **run multiple Grok jobs at once**:

| Need | Tool |
| --- | --- |
| Fix / investigate | `grok_rescue` |
| Plan | `grok_plan` |
| Design | `grok_design` |
| Execute plan | `grok_execute_plan` |
| Workflow | `grok_workflow` |
| Review | `grok_review` |
| Babysit | `grok_babysit` |
| Document | `grok_document` |
| Image / video | `grok_image` / `grok_video` |

How:

1. Split into independent prompts.
2. Start each MCP tool with `background=true` when it may take time.
3. Track each job id via `grok_status`.
4. Collect results with `grok_result`.

Do **not** serialize independent Grok work just because another job is running.

## Tool map

| Need | Tool |
| --- | --- |
| Setup | `grok_setup` |
| Fix / investigate | `grok_rescue` |
| Plan mode | `grok_plan` |
| Design doc | `grok_design` |
| Execute PR plan | `grok_execute_plan` |
| Workflow | `grok_workflow` |
| Review | `grok_review` |
| Challenge design | `grok_adversarial_review` |
| Babysit PRs | `grok_babysit` |
| Document | `grok_document` |
| Image | `grok_image` |
| Video | `grok_video` |
| Sessions | `grok_sessions` |
| Progress | `grok_status` |
| Output | `grok_result` |
| Cancel | `grok_cancel` |
| Handoff context | `grok_transfer` |
