/**
 * Prompt builders that invoke Grok's bundled design / execute-plan skills.
 */

export function buildDesignPrompt(brief, { extraContext = "" } = {}) {
  const task = String(brief || "").trim();
  if (!task) {
    throw new Error("Design brief is required");
  }

  return `You are running the Grok /design skill end-to-end as orchestrator.

Task to design:
${task}
${extraContext ? `\nAdditional context:\n${extraContext}\n` : ""}
Follow the bundled design skill behavior:
- Use design-doc-writer and design-doc-reviewer persona loops (spawn_subagent) until 0 open issues.
- You coordinate only; do not author the design document yourself.
- Include mandatory sections: Key Decisions and PR Plan (ordered PRs with deps).
- Write the final design document to a stable path and report it clearly as:
  DESIGN_DOC_PATH=<absolute-path>
- Also summarize key decisions and the PR plan in your final response.
- Do not implement production application code.`;
}

export function buildExecutePlanPrompt(
  designDocPath,
  {
    concurrency = 4,
    dryRun = false,
    autoPr = false,
    noGraphite = false,
    instructions = "",
    resumePlanId = null
  } = {}
) {
  const doc = String(designDocPath || "").trim();
  if (!doc && !resumePlanId) {
    throw new Error("Design document path is required (or --resume PLAN_ID)");
  }

  const flags = [];
  if (concurrency != null) flags.push(`--concurrency ${Number(concurrency)}`);
  if (dryRun) flags.push("--dry-run");
  if (autoPr) flags.push("--auto-pr");
  if (noGraphite) flags.push("--no-graphite");
  if (instructions) flags.push(`--instructions ${JSON.stringify(instructions)}`);
  if (resumePlanId) flags.push(`--resume ${resumePlanId}`);

  return `You are running the Grok /execute-plan skill end-to-end as orchestrator.

Design document path: ${doc || "(resume only)"}
Effective flags: ${flags.join(" ") || "(defaults)"}

Follow the bundled execute-plan skill:
- Parse the PR Plan DAG, topologically sort, implement in worktree-isolated subagents.
- Run mandatory orchestrator-level review cycles.
- Assemble Graphite stack if gt is available, otherwise plain-git branches.
- You coordinate only; implementation and review go through implementer/reviewer personas.
${dryRun ? "- Dry-run: parse and report linearized order only; do not implement or push.\n" : ""}${
    resumePlanId ? `- Resume PLAN_ID: ${resumePlanId}\n` : ""
  }
Report PLAN_ID, linearized PR order, branch names, PR/compare URLs, and any failures.
Do not merge PRs.`;
}

export function buildPlanModePrompt(task) {
  const text = String(task || "").trim();
  if (!text) {
    throw new Error("Plan task description is required");
  }
  return `Enter plan mode and produce an implementation plan for:

${text}

Requirements:
- Explore the codebase with read tools before planning.
- Write the plan to the session plan.md (plan mode).
- Include: Context, recommended approach, critical files to modify, existing utilities to reuse (with paths), and verification steps (how to test end-to-end).
- Do not implement application code outside the plan file.
When finished, exit plan mode and summarize the plan in your final response. Quote the plan path if known.`;
}
