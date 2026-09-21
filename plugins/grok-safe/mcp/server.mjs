#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  SENSITIVE_TYPES,
  enforceInvocationSecurity,
  resolveGitWorkspace,
  sanitizedEnvironment
} from "./security.mjs";

import { ACCEPTANCE_SCHEMA } from "../scripts/lib/acceptance.mjs";
import { SAFE_SANDBOX_VALUES, SAFE_PERMISSION_VALUES } from "../scripts/lib/control.mjs";

import { CliCatalog } from "../scripts/lib/cli-catalog.mjs";
import { GrokSupervisor } from "../scripts/lib/supervisor.mjs";
import { readJobFile } from "../scripts/lib/jobs.mjs";
import { RUNTIME_SCHEMA } from "../scripts/lib/job-policy.mjs";
let liveSupervisor;
let mcpInitialized = false;
const cliCatalog = new CliCatalog({ isBusy: () => liveSupervisor?.isBusy() || false, beforeUpdate: () => liveSupervisor?.closeIdle(),
  onChange: () => { if (mcpInitialized) sendMessage({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); } });
function supervisor() { return liveSupervisor ||= new GrokSupervisor({ catalog: cliCatalog }); }
const mcpAbortControllers = new Map();

const SERVER_VERSION = "0.5.8-safe.1";
const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");

const stringSchema = (description) => ({ type: "string", description });
const booleanSchema = (description) => ({ type: "boolean", description });
const integerSchema = (description, minimum = 1) => ({ type: "integer", minimum, description });
const WORKSPACE_PROPERTY = {
  cwd: stringSchema(
    "Workspace or repository path for this call. Pass the active Codex project path when the plugin runs from its install cache."
  )
};
const OUTPUT_PROPERTIES = {
  detail: { type: "string", enum: ["summary", "full"], description: "ACP defaults to compact supervision evidence. full includes raw events and complete stored output for inspection." },
  cursor: { type: "integer", minimum: 0, description: "Last returned event cursor; reuse to avoid replay." }
};

/** Shared control surface for long-running Grok jobs (mirrors Claude companion flags). */
const CONTROL_PROPERTIES = {
  sensitiveExclude: { type: "array", items: { type: "string" }, description: "Exclude known dependency/cache directories only." },
  sensitiveAllowTypes: { type: "array", items: { type: "string", enum: ["public-certificate", "test-fixture"] } },
  sensitiveDenyTypes: { type: "array", items: { type: "string", enum: SENSITIVE_TYPES } },
  sensitiveApprovedPaths: { type: "array", items: { type: "string" }, description: "Exact repository-relative paths explicitly approved by the user. Denied types still block." },
  sandbox: { type: "string", enum: SAFE_SANDBOX_VALUES, description: "Grok Safe sandbox profile." },
  planMode: booleanSchema("Enable Grok plan mode (--plan)."),
  permissionMode: { type: "string", enum: SAFE_PERMISSION_VALUES, description: "Grok Safe permission mode." },
  agent: stringSchema("Grok agent name to use."),
  noSubagents: booleanSchema("Disable Grok subagents."),
  subagents: booleanSchema("Explicitly allow Grok subagents for a bounded native workflow. Prefer separate supervised jobs for ordinary implementation."),
  memory: booleanSchema("Enable memory for this session."),
  noMemory: booleanSchema("Disable memory for this session."),
  allow: {
    type: "array",
    items: { type: "string" },
    description: "Permission allow rules (repeatable)."
  },
  deny: {
    type: "array",
    items: { type: "string" },
    description: "Permission deny rules (repeatable)."
  },
  disableWebSearch: booleanSchema("Disable web search tools."),
  forkSession: booleanSchema("Fork the current Grok session."),
  maxTurns: integerSchema("Maximum Grok turns for this job.")
  ,sensitiveApproved: booleanSchema(
    "Set only after the user explicitly approves access to sensitive files or remote/privileged effects."
  )
};

const COMMON_JOB_PROPERTIES = {
  transport: { type: "string", enum: ["acp", "headless"], description: "ACP provides live controls and push progress; headless is the compatibility path." },
  runtime: RUNTIME_SCHEMA,
  acceptance: ACCEPTANCE_SCHEMA,
  ...WORKSPACE_PROPERTY,
  background: booleanSchema("Start a background job and return the job id."),
  model: stringSchema("Grok model id or alias, such as fast or deep."),
  effort: stringSchema("Reasoning effort: none, minimal, low, medium, high, xhigh, or max."),
  json: booleanSchema("Return machine-readable JSON from the companion."),
  ...CONTROL_PROPERTIES
};

const TOOL_DEFINITIONS = [
  { name: 'grok_wait_many', description: 'Wait for any of 1-8 jobs to need attention, then return compact snapshots for all. Reuse each returned cursor.', inputSchema: { type: 'object', required: ['targets'], properties: { ...WORKSPACE_PROPERTY, targets: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } } } }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 } } } },
  { name: 'grok_retry_verification', description: 'Retry deterministic acceptance on a stopped job without asking Grok to implement again. Preserves artifacts and requires Codex review.', inputSchema: { type: 'object', required: ['jobId'], properties: { ...WORKSPACE_PROPERTY, jobId: { type: 'string' } } } },
  { name: 'grok_record_review', description: 'Persist a Codex review decision bound to the verified source hashes. Rejects stale workspaces; approved attestations can gate later stages.', inputSchema: { type: 'object', additionalProperties: false, required: ['jobId', 'decision', 'summary'], properties: { ...WORKSPACE_PROPERTY, jobId: { type: 'string' }, decision: { type: 'string', enum: ['approved', 'changes-requested'] }, summary: { type: 'string' } } } },
  { name: "grok_capabilities", description: "Discover the installed CLI version, available commands, flags and update policy from the actual binary.", inputSchema: { type: "object", properties: { ...WORKSPACE_PROPERTY, refresh: { type: "boolean" } } } },
  { name: "grok_cli_help", description: "Read version-matched native CLI help. Use an advertised command path such as agent stdio or update.", inputSchema: { type: "object", properties: { command: { type: "string" }, ...WORKSPACE_PROPERTY } } },
  { name: "grok_cli_update", description: "Check CLI releases, install stable updates while idle, or configure background checks. auto-stable installs only when no Grok job is active.", inputSchema: { type: "object", properties: { ...WORKSPACE_PROPERTY, action: { type: "string", enum: ["check", "install", "configure"] }, mode: { type: "string", enum: ["off", "check", "auto-stable"] }, intervalMinutes: { type: "integer", minimum: 5, maximum: 1440 } } } },
  { name: "grok_send", description: "Send an idempotent update to a running Grok task: steer at the next native tool boundary, interrupt promptly, or queue for the next prompt. Returns a receipt; wait/events expose delivery acknowledgments.", inputSchema: { type: "object", required: ["jobId", "text"], properties: { ...WORKSPACE_PROPERTY, jobId: { type: "string" }, text: { type: "string" }, delivery: { type: "string", enum: ["steer", "interrupt", "queue"] }, messageId: { type: "string" } } } },
  ...["grok_wait", "grok_events"].map(name => ({ name, description: "Read incremental supervision events. Default waits ignore routine text/thought/tool telemetry; failures and control events wake immediately. Use detail=full for raw diagnostics and always reuse cursor.", inputSchema: { type: "object", required: ["jobId"], properties: { ...WORKSPACE_PROPERTY, ...OUTPUT_PROPERTIES, jobId: { type: "string" }, timeoutMs: { type: "integer", minimum: 0, maximum: 60000 } } } })),
  { name: "grok_session_config", description: "Change a connected session model or reasoning effort using the native ACP configuration interface.", inputSchema: { type: "object", required: ["jobId", "configId", "value"], properties: { ...WORKSPACE_PROPERTY, jobId: { type: "string" }, configId: { type: "string", enum: ["model", "reasoning_effort"] }, value: { type: "string" } } } },
  { name: "grok_run", description: "General supervised Grok CLI task for implementation, planning, documents, media or workflows. Use exact artifact requirements for non-code deliverables; all kinds share live messaging, budgets, recovery and verification.", inputSchema: { type: "object", required: ["prompt"], properties: { ...COMMON_JOB_PROPERTIES, prompt: { type: "string" }, kind: { type: "string", enum: ["task", "plan", "review", "design", "workflow", "document", "image", "video"] }, readOnly: { type: "boolean" }, worktree: { type: "boolean" }, resumeSession: { type: "string" } } } },
  {
    name: "grok_setup",
    description:
      "Check Grok CLI availability, authentication, min version, and doctor. Optionally toggle the stop review gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        enableReviewGate: booleanSchema("Enable the optional stop review gate."),
        disableReviewGate: booleanSchema("Disable the optional stop review gate."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  ...["list_worktrees", "cleanup_worktree", "retain_worktree"].map(name => ({
    name, description: "Inspect or manage plugin-owned worktrees. Cleanup refuses dirty, retained, active or unmerged worktrees.",
    inputSchema: { type: "object", properties: { ...WORKSPACE_PROPERTY, jobId: { type: "string" } },
      ...(name === "list_worktrees" ? {} : { required: ["jobId"] }) }
  })),
  {
    name: "grok_rescue",
    description: "Codex-supervised Grok worker. Writes inside a Git worktree without user prompts; Codex must review the diff before applying it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: stringSchema("The task for Grok to investigate, implement, or fix."),
        readOnly: booleanSchema("Prevent source edits by running Grok in read-only mode."),
        resume: booleanSchema("Resume the latest Grok task session for this repository."),
        resumeSession: stringSchema("Resume a specific Grok session id."),
        fresh: booleanSchema("Start a fresh Grok session."),
        worktree: booleanSchema("Run edits in a Grok-managed git worktree."),
        worktreeName: stringSchema("Name for a Grok-managed git worktree."),
        worktreeRef: stringSchema("Base ref for the Grok worktree."),
        check: booleanSchema("Run plugin-side delivery checks (defaults to true)."),
        acceptance: ACCEPTANCE_SCHEMA,
        verbatim: booleanSchema("Avoid adding extra wrapper instructions to the prompt."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_plan",
    description:
      "Headless Grok plan mode. Explores the codebase and harvests plan.md into .grok-plans/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("What to plan. Defaults to a generic explore-and-plan brief."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_review",
    description: "Run a structured read-only Grok review of the working tree, branch, or PR.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Optional review focus, such as auth, race conditions, or data loss."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_adversarial_review",
    description: "Ask Grok to challenge a design, branch, working tree, or PR for hidden risks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Design or implementation assumptions Grok should challenge."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_workflow",
    description:
      "List or run Grok Rhai multi-agent workflows. Use action=list (read-only) or action=run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("list (default) or run."),
        name: stringSchema("Workflow name (required for run)."),
        args: {
          type: "array",
          items: { type: "string" },
          description: "Workflow args as key=value pairs."
        },
        validateOnly: booleanSchema("Validate the workflow without executing (read-only)."),
        agentBudget: integerSchema("Maximum native workflow agents when subagents=true."),
        prompt: stringSchema("Optional free-form prompt passed after flags."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_design",
    description:
      "Run design-doc writer/reviewer loop. Harvests design docs into .grok-designs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("Design brief."),
        agentBudget: integerSchema("Maximum native design agents when subagents=true."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_execute_plan",
    description:
      "Execute a design-doc PR Plan DAG. Pass designDoc path, or latest=true for the newest design.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        designDoc: stringSchema("Path to design doc. Omit with latest=true."),
        latest: booleanSchema("Use the latest design doc under .grok-designs/."),
        concurrency: integerSchema("Parallel PR plan concurrency."),
        agentBudget: integerSchema("Maximum native plan agents when subagents=true."),
        dryRun: booleanSchema("Dry-run only (read-only, no yolo)."),
        autoPr: booleanSchema("Open PRs automatically when the plan supports it."),
        noGraphite: booleanSchema("Disable Graphite stacking."),
        resume: stringSchema("Resume a prior execute-plan PLAN_ID."),
        instructions: stringSchema("Extra instructions for the executor."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_babysit",
    description:
      "Watch PRs and fix CI/review issues via pr-babysit. action=list is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("add | list | check | remove. Defaults to list."),
        prs: {
          type: "array",
          items: { type: "string" },
          description: "PR numbers for add/check/remove."
        },
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_document",
    description: "Generate docx, pdf, or pptx via Grok document skills into .grok-docs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: stringSchema("Document type: docx, pdf, or pptx."),
        prompt: stringSchema("Document brief / content request."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_sessions",
    description: "List, search, or export Grok sessions for this workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        action: stringSchema("list (default), search, or export."),
        query: stringSchema("Search query (for search)."),
        sessionId: stringSchema("Session id (for export)."),
        limit: integerSchema("Max sessions to return."),
        output: stringSchema("Export output path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_image",
    description: "Generate or edit an image with Grok and store artifacts under .grok-media/image by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        prompt: stringSchema("Image prompt."),
        background: booleanSchema("Start a background image job and return the job id."),
        edit: stringSchema("Path to an image to edit."),
        aspect: stringSchema("Aspect ratio, such as 16:9, 1:1, or 9:16."),
        model: stringSchema("Grok model id or alias."),
        effort: stringSchema("Reasoning effort."),
        out: stringSchema("Output directory, relative to the workspace or absolute."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_video",
    description: "Generate a short video with Grok and store artifacts under .grok-media/video by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        prompt: stringSchema("Video prompt."),
        background: booleanSchema("Start a background video job and return the job id."),
        image: stringSchema("Primary source image path."),
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Additional reference image paths."
        },
        duration: stringSchema("Video duration supported by Grok, commonly 6 or 10."),
        aspect: stringSchema("Aspect ratio, such as 16:9, 1:1, or 9:16."),
        model: stringSchema("Grok model id or alias."),
        effort: stringSchema("Reasoning effort."),
        out: stringSchema("Output directory, relative to the workspace or absolute."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_status",
    description: "Show active and recent Grok jobs, live progress, and usage when available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Specific job id to inspect."),
        ...OUTPUT_PROPERTIES,
        all: booleanSchema("Include older jobs, not only the recent default window."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_result",
    description: "Read the stored result for a completed Grok job (plan body preferred for plan jobs).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Specific job id. Omit only when there is one unambiguous recent job."),
        ...OUTPUT_PROPERTIES,
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_cancel",
    description: "Cancel a running Grok background job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Job id to cancel."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_transfer",
    description: "Build guidance for transferring host-session context into Grok.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        source: stringSchema("Optional transcript/source path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  }
];

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function resolveMcpCwd(input = {}) {
  const requested = hasValue(input.cwd) ? String(input.cwd) : process.cwd();
  try {
    return resolveGitWorkspace(requested);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function pushFlag(args, condition, flag) {
  if (condition) {
    args.push(flag);
  }
}

function pushValue(args, value, flag) {
  if (hasValue(value)) {
    args.push(flag, String(value));
  }
}

function pushArray(args, values, flag) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (hasValue(value)) {
      args.push(flag, String(value));
    }
  }
}

function appendControlArgs(args, input) {
  pushValue(args, input.sandbox, "--sandbox");
  pushFlag(args, input.planMode, "--plan");
  pushValue(args, input.permissionMode, "--permission-mode");
  pushValue(args, input.agent, "--agent");
  pushFlag(args, input.noSubagents, "--no-subagents");
  pushFlag(args, input.subagents, "--subagents");
  pushFlag(args, input.memory, "--memory");
  pushFlag(args, input.noMemory, "--no-memory");
  pushArray(args, input.allow, "--allow");
  pushArray(args, input.deny, "--deny");
  pushFlag(args, input.disableWebSearch, "--disable-web-search");
  pushFlag(args, input.forkSession, "--fork-session");
  pushValue(args, input.maxTurns, "--max-turns");
  pushFlag(args, input.sensitiveApproved, "--sensitive-approved");
}

function appendCommonJobArgs(args, input) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  appendControlArgs(args, input);
  pushFlag(args, input.json, "--json");
}

function appendReviewArgs(args, input) {
  appendCommonJobArgs(args, input);
  pushValue(args, input.base, "--base");
  pushValue(args, input.scope, "--scope");
  pushValue(args, input.pr, "--pr");
  pushFlag(args, input.postPending, "--post-pending");
  if (hasValue(input.focus)) {
    args.push(String(input.focus));
  }
}

function appendMediaArgs(args, input, kind) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  pushValue(args, input.aspect, "--aspect");
  pushValue(args, input.out, "--out");
  if (kind === "image") {
    pushValue(args, input.edit, "--edit");
  } else {
    pushValue(args, input.image, "--image");
    pushValue(args, input.duration, "--duration");
    for (const ref of input.refs || []) {
      pushValue(args, ref, "--ref");
    }
  }
  pushFlag(args, input.json, "--json");
  if (hasValue(input.prompt)) {
    args.push(String(input.prompt));
  }
}

export function listToolDefinitions() {
  return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
}

export function buildCompanionInvocation(toolName, input = {}) {
  if (!TOOL_MAP.has(toolName)) {
    throw new Error(`Unknown Grok tool: ${toolName}`);
  }

  const args = [];
  let command;

  switch (toolName) {
    case "list_worktrees":
    case "cleanup_worktree":
    case "retain_worktree":
      args.push("worktrees", toolName === "list_worktrees" ? "list" : toolName === "cleanup_worktree" ? "cleanup" : "retain");
      if (toolName !== "list_worktrees") {
        if (!input.jobId || !/^[A-Za-z0-9_-]+$/.test(input.jobId)) throw new Error("A valid jobId is required");
        args.push(input.jobId);
      }
      break;
    case "grok_setup":
      command = "setup";
      args.push(command);
      pushFlag(args, input.enableReviewGate, "--enable-review-gate");
      pushFlag(args, input.disableReviewGate, "--disable-review-gate");
      pushFlag(args, input.json, "--json");
      break;
    case "grok_rescue":
      command = "task";
      args.push(command);
      pushFlag(args, input.background, "--background");
      pushFlag(args, input.readOnly, "--read-only");
      if (input.resumeSession) {
        pushValue(args, input.resumeSession, "--resume-session");
      } else if (input.resume) {
        args.push("--resume-last");
      } else if (input.fresh) {
        args.push("--fresh");
      }
      pushValue(args, input.model, "--model");
      pushValue(args, input.effort, "--effort");
      if (input.worktreeName) {
        pushValue(args, input.worktreeName, "--worktree-name");
      } else {
        if (input.worktree !== undefined) args.push(input.worktree ? "--worktree" : "--worktree=false");
      }
      pushValue(args, input.worktreeRef, "--worktree-ref");
      if (input.check !== undefined) args.push(input.check ? "--check" : "--check=false");
      if (input.acceptance !== undefined) pushValue(args, JSON.stringify(input.acceptance), "--acceptance");
      pushFlag(args, input.verbatim, "--verbatim");
      appendControlArgs(args, input);
      pushFlag(args, input.json, "--json");
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_plan":
      command = "plan";
      args.push(command);
      appendCommonJobArgs(args, input);
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_review":
      command = "review";
      args.push(command);
      appendReviewArgs(args, input);
      break;
    case "grok_adversarial_review":
      command = "adversarial-review";
      args.push(command);
      appendReviewArgs(args, input);
      break;
    case "grok_workflow": {
      command = "workflow";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      if (action === "run") {
        args.push("run");
        if (hasValue(input.name)) {
          args.push(String(input.name));
        }
        for (const pair of input.args || []) {
          if (hasValue(pair)) {
            args.push("--arg", String(pair));
          }
        }
        pushFlag(args, input.validateOnly, "--validate-only");
        pushValue(args, input.agentBudget, "--agent-budget");
        appendCommonJobArgs(args, input);
        if (hasValue(input.prompt)) {
          args.push(String(input.prompt));
        }
      } else {
        args.push("list");
        pushFlag(args, input.json, "--json");
      }
      break;
    }
    case "grok_design":
      command = "design";
      args.push(command);
      appendCommonJobArgs(args, input);
      pushValue(args, input.agentBudget, "--agent-budget");
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_execute_plan":
      command = "execute-plan";
      args.push(command);
      if (input.latest) {
        args.push("--latest");
      } else if (hasValue(input.designDoc)) {
        args.push(String(input.designDoc));
      }
      pushValue(args, input.concurrency, "--concurrency");
      pushValue(args, input.agentBudget, "--agent-budget");
      pushFlag(args, input.dryRun, "--dry-run");
      pushFlag(args, input.autoPr, "--auto-pr");
      pushFlag(args, input.noGraphite, "--no-graphite");
      pushValue(args, input.resume, "--resume");
      pushValue(args, input.instructions, "--instructions");
      appendCommonJobArgs(args, input);
      break;
    case "grok_babysit": {
      command = "babysit";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      args.push(action);
      for (const pr of input.prs || []) {
        if (hasValue(pr)) {
          args.push(String(pr));
        }
      }
      // list is read-only; still allow background for check/add when requested
      if (action !== "list") {
        appendCommonJobArgs(args, input);
      } else {
        pushFlag(args, input.json, "--json");
      }
      break;
    }
    case "grok_document":
      command = "document";
      args.push(command);
      pushValue(args, input.type, "--type");
      appendCommonJobArgs(args, input);
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_sessions": {
      command = "sessions";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      args.push(action);
      if (action === "search" && hasValue(input.query)) {
        args.push(String(input.query));
      }
      if (action === "export" && hasValue(input.sessionId)) {
        args.push(String(input.sessionId));
      }
      pushValue(args, input.limit, "--limit");
      pushValue(args, input.output, "--output");
      pushFlag(args, input.json, "--json");
      break;
    }
    case "grok_image":
      command = "image";
      args.push(command);
      appendMediaArgs(args, input, "image");
      break;
    case "grok_video":
      command = "video";
      args.push(command);
      appendMediaArgs(args, input, "video");
      break;
    case "grok_status":
      command = "status";
      args.push(command);
      pushFlag(args, input.all, "--all");
      pushFlag(args, input.json, "--json");
      if (hasValue(input.jobId)) {
        args.push(String(input.jobId));
      }
      break;
    case "grok_result":
      command = "result";
      args.push(command);
      pushFlag(args, input.json, "--json");
      if (hasValue(input.jobId)) {
        args.push(String(input.jobId));
      }
      break;
    case "grok_cancel":
      command = "cancel";
      args.push(command);
      pushFlag(args, input.json, "--json");
      if (hasValue(input.jobId)) {
        args.push(String(input.jobId));
      }
      break;
    case "grok_transfer":
      command = "transfer";
      args.push(command);
      pushValue(args, input.source, "--source");
      pushFlag(args, input.json, "--json");
      break;
  }

  return { command, args };
}

export async function runCompanion(toolName, input = {}, context = {}) {
  const content = value => {
    const serialized = JSON.stringify(value);
    const text = serialized.length <= 2400 ? serialized : JSON.stringify({
      jobId: value?.jobId || value?.id || null, status: value?.status || null, cursor: value?.cursor ?? null,
      hasMore: Boolean(value?.hasMore), structuredContent: true,
      instruction: "Use structuredContent; the duplicate text representation was compacted."
    });
    return { isError: ["failed", "incomplete", "blocked"].includes(value?.status), structuredContent: value, content: [{ type: "text", text }] };
  };
  if (toolName === 'grok_wait_many') return content(await supervisor().waitMany(resolveMcpCwd(input), input.targets, input.timeoutMs ?? 60000, context.signal));
  if (toolName === 'grok_retry_verification') return content(await supervisor().retryVerification(resolveMcpCwd(input), input.jobId));
  if (toolName === 'grok_record_review') return content(supervisor().recordReview(resolveMcpCwd(input), input.jobId, input));
  if (toolName === "grok_capabilities") {
    const catalog = await cliCatalog.refresh(Boolean(input.refresh));
    let protocol;
    try { protocol = await cliCatalog.protocolCapabilities(); } catch (error) { protocol = { available: false, error: error.message }; }
    return content({ version: catalog.version, capturedAt: catalog.capturedAt, acp: catalog.acp, protocol, commands: Object.keys(catalog.pages), addedCommands: catalog.addedCommands, removedCommands: catalog.removedCommands, updatePolicy: cliCatalog.policy, lastUpdate: cliCatalog.lastUpdate || null });
  }
  if (toolName === "grok_cli_help") return content(await cliCatalog.help(input.command || ""));
  if (toolName === "grok_cli_update") return content(input.action === "configure" ? cliCatalog.configure(input) : await cliCatalog.checkUpdate({ install: input.action === "install" }));
  if (["grok_send", "grok_wait", "grok_events", "grok_session_config", "grok_run"].includes(toolName) || (toolName === "grok_rescue" && input.transport !== "headless")) {
    const cwd = resolveMcpCwd(input), runtime = supervisor();
    if (toolName === "grok_send") return content(await runtime.send(cwd, input.jobId, input));
    if (toolName === "grok_session_config") return content(await runtime.configure(cwd, input.jobId, input.configId, input.value));
    if (["grok_wait", "grok_events"].includes(toolName)) return content(await runtime.wait(cwd, input.jobId, input.cursor || 0, toolName === "grok_events" ? 0 : input.timeoutMs ?? 60000, context.signal, input.detail));
    enforceInvocationSecurity("grok_rescue", { ...input, contentScoped: true }, cwd);
    return content(await runtime.start(cwd, input, { kind: input.kind || "task", onProgress: context.onProgress, signal: context.signal }));
  }
  if (["grok_cancel", "grok_status", "grok_result"].includes(toolName) && input.jobId) {
    const cwd = resolveMcpCwd(input);
    if (liveSupervisor?.find(cwd, input.jobId)) return content(toolName === "grok_cancel" ? liveSupervisor.cancel(cwd, input.jobId) : await liveSupervisor.wait(cwd, input.jobId, input.cursor || 0, 0, context.signal, input.detail));
    if (toolName !== "grok_cancel" && readJobFile(cwd, input.jobId)?.transport === "acp") return content(await supervisor().wait(cwd, input.jobId, input.cursor || 0, 0, context.signal, input.detail));
  }
  const { args } = buildCompanionInvocation(toolName, input);
  const cwd = resolveMcpCwd(input);
  enforceInvocationSecurity(toolName, input, cwd);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd,
      env: sanitizedEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
      });
    });
    child.on("close", (code, signal) => {
      const text = stdout || stderr || `grok companion exited with code ${code ?? signal}`;
      finish({
        isError: code !== 0,
        content: [{ type: "text", text }]
      });
    });
  });
}

/**
 * Codex plugin MCP hosts speak newline-delimited JSON over stdio
 * (same framing as bundled plugins such as sites / codex-security).
 * Do not use LSP Content-Length framing — Codex never sends those headers,
 * so tools/list never completes and grok_* tools never appear in the session.
 */
function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(message) {
  const id = message.id;
  try {
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "grok-safe", version: SERVER_VERSION }
          }
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listToolDefinitions() } };
      case "tools/call": {
        const name = message.params?.name;
        const input = message.params?.arguments || {};
        const abort = new AbortController(); mcpAbortControllers.set(id, abort);
        const token = message.params?._meta?.progressToken;
        let progress = 0;
        let result;
        try { result = await runCompanion(name, input, { signal: abort.signal, onProgress: token === undefined ? undefined : event => sendMessage({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: JSON.stringify(event) } }) }); }
        finally { mcpAbortControllers.delete(id); }
        return { jsonrpc: "2.0", id, result };
      }
      case "notifications/initialized":
        mcpInitialized = true;
        return null;
      case "notifications/cancelled":
        mcpAbortControllers.get(message.params?.requestId)?.abort();
        return null;
      default:
        if (id === undefined || id === null) {
          return null;
        }
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown method: ${message.method}` }
        };
    }
  } catch (error) {
    if (id === undefined || id === null) {
      return null;
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function startStdioServer() {
  cliCatalog.startMonitor();
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  lines.on("close", () => { liveSupervisor?.close(); cliCatalog.close(); });
  lines.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.method === undefined && message.id !== undefined) {
      return;
    }

    void handleRequest(message).then((response) => {
      if (response) {
        sendMessage(response);
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
