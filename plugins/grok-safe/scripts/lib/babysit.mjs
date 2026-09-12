const ACTIONS = new Set(["add", "list", "check", "remove"]);

/**
 * Parse babysit CLI: babysit <action> [pr numbers...]
 */
export function parseBabysitInvocation(positionals = []) {
  const action = String(positionals[0] || "").toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new Error(
      `Unknown babysit action: ${positionals[0] || "(missing)"}. Expected: add|list|check|remove`
    );
  }
  const prs = positionals
    .slice(1)
    .map((p) => String(p).replace(/^#/, ""))
    .filter((p) => /^\d+$/.test(p))
    .map((p) => Number(p));

  if ((action === "add" || action === "remove") && prs.length === 0) {
    throw new Error(`babysit ${action} requires at least one PR number`);
  }

  return { action, prs };
}

/**
 * Build prompt that invokes Grok pr-babysit skill.
 */
export function buildBabysitPrompt(action, prs = []) {
  const prList = prs.length ? prs.map((n) => String(n)).join(" ") : "";
  switch (action) {
    case "add":
      return [
        "You are running the Grok /pr-babysit skill.",
        `Execute: /pr-babysit add ${prList}`,
        "Follow the bundled pr-babysit skill for add: verify gh auth, fetch PR details, detect stacks, register PRs, report what was added.",
        "Do not merge PRs. Report the updated watchlist."
      ].join("\n");
    case "remove":
      return [
        "You are running the Grok /pr-babysit skill.",
        `Execute: /pr-babysit remove ${prList}`,
        "Remove only the specified PR(s) from the watchlist and report confirmation."
      ].join("\n");
    case "list":
      return [
        "You are running the Grok /pr-babysit skill.",
        "Execute: /pr-babysit list",
        "Show all watched PRs for this repo grouped by stack, with status and last checked time."
      ].join("\n");
    case "check":
      return [
        "You are running the Grok /pr-babysit skill.",
        "Execute: /pr-babysit check",
        "Run one full check cycle: query each watched PR, fix CI/review/conflicts per skill rules (worktree-isolated subagents), update state, report results.",
        "Never force-push without --force-with-lease. Never merge PRs.",
        "Cap fix attempts per skill rules. Report last_status per PR."
      ].join("\n");
    default:
      throw new Error(`Unknown babysit action: ${action}`);
  }
}

export function babysitSupportsBackground(action) {
  return action === "check" || action === "add";
}
