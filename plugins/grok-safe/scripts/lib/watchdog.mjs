// Count explicit turn boundaries only. Stream text chunks are not model turns.
// This function is embedded in the runner so foreground and background agree.
export function writeWatchShouldStall(lastChange, now, activeTools, idleMs = 180000) {
  return Number(activeTools) === 0 && now - lastChange > idleMs;
}

export function createActionWatchdog(maxNarrationOnlyTurns = 2) {
  const metrics = { turns: 0, actionTurns: 0, narrationOnlyTurns: 0, inspectionTurns: 0, mutationTurns: 0, verificationTurns: 0, duplicateReads: 0 };
  let phase = "inspecting", action = false, consecutive = 0, turnEventsObserved = false;
  const reads = new Set();
  return {
    observe(evt) {
      if (evt.type === "tool_call" || evt.type === "tool_use") {
        action = true;
        const name = evt.name || evt.toolName || evt.tool?.name || "";
        if (/edit|write|patch/i.test(name)) phase = "editing";
        if (/read/i.test(name)) {
          const key = JSON.stringify(evt.input || evt.arguments || {});
          if (reads.has(key)) metrics.duplicateReads += 1;
          reads.add(key);
        }
      }
      if (evt.type === "turn_end") {
        turnEventsObserved = true;
        metrics.turns += 1;
        if (action) {
          metrics.actionTurns += 1;
          if (phase === "editing") metrics.mutationTurns += 1;
          else metrics.inspectionTurns += 1;
          consecutive = 0;
        } else { metrics.narrationOnlyTurns += 1; consecutive += 1; }
        action = false;
      }
      return { ...metrics, phase, turnEventsObserved, warning: consecutive === maxNarrationOnlyTurns, stalled: consecutive > maxNarrationOnlyTurns };
    }
  };
}
