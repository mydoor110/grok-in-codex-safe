import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.mjs";
import { JobEvents, normalizeGrokEvent } from "./events.mjs";
import { JobPolicy, normalizeRuntime, workspacePath } from "./job-policy.mjs";
import { normalizeControlOptions } from "./control.mjs";
import { normalizeAcceptance, snapshotWorkspace, deliveryArtifactPaths } from "./acceptance.mjs";
import { prepareExecutionWorkspace } from "./execution-workspace.mjs";
import { generateJobId, resolveJobsDir, writeJobFile, upsertJob, readJobFile, listJobs, recordTaskSession } from "./jobs.mjs";
import { sanitizedEnvironment } from "../../mcp/security.mjs";
import { preflightExecution } from './preflight.mjs';
import { acquireExecutionLock, processAlive } from './execution-lock.mjs';

const VERIFIER = fileURLToPath(new URL("../verification-worker.mjs", import.meta.url));
const terminal = job => !["running", "queued", "verifying"].includes(job.status);
export function publicExecution(job, detail = "full") {
  const { initialSnapshot, finalSnapshot, security, control, promptFile, ...publicJob } = job;
  if (detail === "full") return publicJob;
  const { prompt, checkpoint, runtime, environment, pendingMessages, resultText, tests, commandReceipts, ...summary } = publicJob;
  const receipt = ({ stdout, stderr, ...evidence }) => evidence.exitCode === 0 ? evidence : { ...evidence, stdout, stderr };
  const result = { ...summary,
    ...(tests ? { tests: tests.map(receipt) } : {}),
    ...(commandReceipts ? { commandReceipts: commandReceipts.map(receipt) } : {}),
    ...(resultText ? { resultText: resultText.slice(0, 2000), resultTextTruncated: resultText.length > 2000 } : {}),
    evidenceFile: path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.json`),
    eventsFile: path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.events.jsonl`),
    ...(job.write ? { reviewRequired: "Codex must inspect the complete diff, untracked files and verification evidence before accepting delivery." } : {}) };
  // Never silently discard evidence: large fields become explicit references to the stored job.
  const referencedFields = [];
  for (const key of Object.keys(result)) if (JSON.stringify(result[key] ?? null).length > 2200) {
    referencedFields.push(key); result[key] = { reference: `${result.evidenceFile}#/${key}`, omitted: true };
  }
  if (JSON.stringify(result).length > 14000) {
    for (const key of Object.keys(result)) if (!['id', 'jobId', 'status', 'implementationStatus', 'artifactStatus', 'testStatus', 'testSummary', 'acceptancePassed', 'taskCompleted', 'reviewStatus', 'integrationStatus', 'evidenceFile', 'eventsFile', 'reviewRequired', 'infrastructureErrors', 'images', 'productionChanged', 'remainingRisks', 'oracleChanged', 'capabilities', 'artifacts', 'cleanup', 'stage', 'stageResult'].includes(key)) {
      referencedFields.push(key); delete result[key];
    }
  }
  if (referencedFields.length) result.referencedFields = referencedFields;
  return result;
}
function verifyAsync(job, processOk = true, exitCode = 0, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFIER], { cwd: job.executionPath, env: sanitizedEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    child.on("message", event => { try { onProgress(event); } catch (error) { child.kill(); reject(error); } });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject); child.on("close", code => { try { if (code !== 0) throw new Error(error || "Verifier crashed"); resolve(JSON.parse(output)); } catch (e) { reject(e); } });
    child.stdin.end(JSON.stringify({ job, processOk, exitCode }));
  });
}

export class GrokSupervisor {
  constructor({ catalog, clientFactory = (binary, args, options) => new AcpClient(binary, args, options), verifier = verifyAsync, preflight = preflightExecution, maxConcurrent = 3 } = {}) {
    this.catalog = catalog; this.clientFactory = clientFactory; this.verifier = verifier; this.preflight = preflight; this.maxConcurrent = maxConcurrent; this.workers = new Map(); this.diskEvents = new Map(); this.closing = false;
  }
  isBusy() { return [...this.workers.values()].some(w => !terminal(w.job)); }
  find(cwd, id) {
    const worker = this.workers.get(id);
    if (worker && path.resolve(worker.job.workspaceRoot) !== path.resolve(cwd)) throw new Error("Job belongs to another workspace");
    return worker;
  }
  async start(cwd, input, { kind = "task", prompt = input.prompt, onProgress, signal } = {}) {
    if (this.catalog.updating) throw new Error("CLI_UPDATE_IN_PROGRESS: retry after the idle update finishes");
    if ([...this.workers.values()].filter(w => !terminal(w.job)).length >= this.maxConcurrent) throw new Error('CONCURRENCY_LIMIT: wait for an active job before dispatching more work');
    if (!prompt?.trim()) throw new Error("A task prompt is required");
    const control = normalizeControlOptions(input), write = !input.readOnly && !input.planMode;
    const acceptance = normalizeAcceptance(input.acceptance || {}, control, { write }), runtime = normalizeRuntime(input.runtime);
    // Validate the installed verifier and command environment before creating a worktree.
    const sourceEnvironment = this.preflight(cwd, acceptance, control, { checkWritable: write });
    if (input.bestOfN > 1) throw new Error("UNSUPPORTED_OPTION: independent attempts must be started as separate supervised jobs");
    if (input.worktreeName) throw new Error("UNSUPPORTED_OPTION: named worktrees are not supported by the managed workspace transport");
    if (input.forkSession) throw new Error("UNSUPPORTED_OPTION: use a fresh task or resume the original session");
    if (write && control.sandbox === "read-only") throw new Error("CAPABILITY_MISSING: write task requires a writable sandbox");
    const cwdJobs = resolveJobsDir(cwd); fs.mkdirSync(cwdJobs, { recursive: true });
    let previous;
    if (input.resumeSession || input.resume) {
      previous = listJobs(cwd).map(j => readJobFile(cwd, j.id) || j).find(j => input.resumeSession ? j.grokSessionId === input.resumeSession : j.kind === kind);
      if (!previous || !terminal(previous)) throw new Error("RESUME_CONTEXT_LOST: original job is unavailable or running");
      if (input.acceptance || input.worktree !== undefined || input.worktreeRef) throw new Error("Resume cannot replace workspace or acceptance conditions");
    }
    const id = generateJobId(kind);
    const workspace = prepareExecutionWorkspace({ cwd, jobId: id, jobsDir: cwdJobs, write, worktree: input.worktree ?? write,
      worktreeRef: input.worktreeRef, previous, acceptance });
    const release = write || previous ? acquireExecutionLock(cwdJobs, workspace.executionPath, id) : () => {};
    let environment;
    try { environment = this.preflight(workspace.executionPath, previous?.acceptance || acceptance, control, { installation: sourceEnvironment.installation, checkWritable: write }); }
    catch (error) { release(); throw error; }
    try {
    const job = { id, jobId: id, schemaVersion: 5, kind, title: prompt.slice(0, 120), prompt, status: "running", write,
      createdAt: new Date().toISOString(), workspaceRoot: cwd, ...workspace, environment: { ...environment,
        cleanupOwnershipLabel: `io.grok-safe.job-id=${id}`,
        cleanupInstruction: 'Label task-created Docker containers, networks and volumes with cleanupOwnershipLabel; automatic cleanup retains resources without that exact label.' },
      round: 0, messages: previous?.messages || {}, implementationStatus: 'running', artifactStatus: 'unknown', testStatus: 'not-run', infrastructureErrors: [], reviewStatus: 'pending', integrationStatus: 'not-merged',
      control, security: { ...input }, acceptance: previous?.acceptance || acceptance, runtime,
      check: previous?.check ?? input.check ?? true, requestedModel: input.model || null, effort: input.effort || null,
      transport: "acp", worktree: workspace.workspaceMode === "managed-worktree", worktreeName: input.worktreeName || null,
      logFile: path.join(cwdJobs, `${id}.log`), progressFile: path.join(cwdJobs, `${id}.progress.json`), commandReceipts: [] };
    if (kind !== "task") job.initialSnapshot = snapshotWorkspace(job.executionPath, [...(job.acceptance.requiredArtifacts || []), ...deliveryArtifactPaths(job.executionPath, kind)]);
    const events = new JobEvents(path.join(cwdJobs, `${id}.events.jsonl`));
    const worker = { job, events, input, pendingMessages: previous?.pendingMessages || [], currentText: "", onProgress, consumedIds: new Set(Object.keys(job.messages)), active: false, release };
    worker.policy = new JobPolicy(job, (type, data) => this.publish(worker, type, data));
    this.workers.set(id, worker); this.persist(worker); this.publish(worker, "phase", { phase: "inspecting" });
    if (prompt.length > 6000 || (acceptance.allowedPaths?.length || 0) > 8 || (acceptance.requiredCommands?.length || 0) > 5) this.publish(worker, 'scope-warning', { reason: 'Large handoff by prompt/path/verification count; Codex should consider independently verifiable subtasks. This is a heuristic, not a semantic scope assessment.' });
    if (job.baselineWarning) this.publish(worker, 'baseline-warning', { message: job.baselineWarning });
    worker.done = this.run(worker, previous).catch(error => this.fail(worker, error)).finally(async () => {
      try {
        await events.flush();
        if (events.ioError) { Object.assign(job, { status: 'incomplete', taskCompleted: false, acceptancePassed: false, infrastructureErrors: [{ code: 'EVENT_LOG_UNAVAILABLE', message: events.ioError.message }] }); this.persist(worker); }
      } finally { release(); }
    });
    if (input.background !== false) { worker.onProgress = undefined; return this.snapshot(worker); }
    const abort = () => this.cancel(cwd, id);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    try { await worker.done; return this.snapshot(worker); } finally { worker.onProgress = undefined; signal?.removeEventListener("abort", abort); }
    } catch (error) { release(); throw error; }
  }
  publish(worker, type, data = {}) {
    if (this.closing) return;
    const event = worker.events.publish(type, { ...data, jobId: worker.job.id, round: worker.job.round || 0 });
    if (type === "phase") worker.job.phase = data.phase;
    if (data.messageId && worker.job.messages?.[data.messageId]) worker.job.messages[data.messageId].status = type.replace(/^message-/, '');
    worker.onProgress?.(event);
    return event;
  }
  persist(worker) {
    clearTimeout(worker.persistTimer); worker.persistTimer = null;
    worker.job.checkpoint = worker.policy.checkpoint(); worker.job.updatedAt = new Date().toISOString();
    worker.job.pendingMessages = worker.pendingMessages;
    writeJobFile(worker.job.workspaceRoot, worker.job); upsertJob(worker.job.workspaceRoot, worker.job);
    const action = worker.policy.currentAction?.();
    fs.writeFileSync(worker.job.progressFile, JSON.stringify({ phase: worker.job.phase || worker.policy.phase, updatedAt: worker.job.updatedAt,
      cursor: worker.events.revision, metrics: worker.policy.metrics,
      currentAction: action?.action, blockingReason: action?.blocking,
      lastActivityAt: worker.policy.lastActivity ? new Date(worker.policy.lastActivity).toISOString() : undefined,
      activeTools: worker.policy.activeTools?.size || 0,
      progress: worker.policy.progressSnapshot?.(),
      mutatesProduction: (worker.job.acceptance?.capabilities || []).some(name => name === "push" || name === "deploy")
    }));
  }
  schedulePersist(worker) {
    if (!worker.persistTimer) worker.persistTimer = setTimeout(() => {
      worker.persistTimer = null;
      try { this.persist(worker); } catch (error) { worker.persistenceError = error; this.publish(worker, 'infrastructure-error', { code: 'STATE_WRITE_FAILED', message: error.message }); if (worker.active) this.requestCancel(worker); }
    }, 100);
  }
  snapshot(worker, cursor = 0, detail = "summary") { return { ...publicExecution(worker.job, detail), ...worker.events.since(cursor, detail !== "full"), metrics: worker.policy.metrics, liveConnection: Boolean(worker.client && !worker.client.closed), eventSource: 'live' }; }
  handleHook(worker, event) {
    const type = event.hookEventName || event.hook_event_name;
    worker.hooksSeen = true;
    worker.observedHooks ||= new Set(); worker.observedHooks.add(type);
    this.publish(worker, "hook", { hookEvent: type });
    let reply = {};
    try {
      if (type === "pre_tool_use") reply = worker.policy.before(event);
      else if (["post_tool_use", "post_tool_use_failure"].includes(type)) reply = worker.policy.after(event, false);
      else if (type === "stop") reply = worker.policy.stop(event);
    } catch (error) { reply = { decision: "deny", reason: error.message }; }
    if (reply.decision === "deny" || reply.decision === "block" || reply.continue === false) {
      this.publish(worker, "supervision-blocked", { hookEvent: type, decision: reply.decision,
        reason: reply.reason || reply.stopReason, tool: event.toolName || event.tool_name });
    }
    if (type === "post_tool_use_failure") this.publish(worker, "tool-failed", { hookEvent: type, event });
    if (reply.continue === false) worker.budgetStop = { code: "STALLED", message: reply.stopReason, phase: worker.policy.phase };
    // SDK pre-tool callbacks support allow/deny only. Deliver steering at a
    // supported post-tool/stop boundary; queue messages remain next-turn work.
    if (["post_tool_use", "stop"].includes(type)) {
      const messages = worker.pendingMessages.filter(m => m.delivery === "steer");
      worker.pendingMessages = worker.pendingMessages.filter(m => m.delivery !== "steer");
      if (messages.length) {
        reply.additionalContext = messages.map(m => m.text).join("\n\n");
        if (type === "stop") { reply.decision = "block"; reply.reason = reply.additionalContext; }
        for (const m of messages) this.publish(worker, "message-delivered", { messageId: m.id, delivery: "native-hook", latencyMs: Date.now() - m.receivedAt });
      }
    }
    this.schedulePersist(worker);
    return { decision: reply.decision === "allow" ? "continue" : reply.decision || "continue",
      systemMessage: reply.reason, continue: reply.continue, stopReason: reply.stopReason,
      additionalContext: reply.additionalContext };
  }
  async clientRequest(worker, method, params) {
    if (params.sessionId && worker.job.grokSessionId && params.sessionId !== worker.job.grokSessionId) throw new Error("Unknown ACP session");
    if (["_x.ai/hooks/run", "x.ai/hooks/run"].includes(method)) return this.handleHook(worker, params);
    if (method === "fs/read_text_file") {
      const entry = worker.policy.inspectFile(params.path); if (!entry) throw new Error("File is unavailable");
      const lines = entry.content.split(/\r?\n/); return { content: lines.slice(Math.max(0, (params.line || 1) - 1), params.limit ? (params.line || 1) - 1 + params.limit : undefined).join("\n") };
    }
    if (method === "fs/write_text_file") {
      worker.policy.before({ toolName: "write_file", toolInput: { path: params.path } });
      const file = workspacePath(worker.job.executionPath, params.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, params.content);
      worker.policy.after({ toolName: "write_file" }); return {};
    }
    if (method === "session/request_permission") {
      const tool = params.toolCall || {};
      try {
        worker.policy.before({ toolName: tool.rawInput?.variant || tool.title?.split(/[ `]/)[0] || tool.kind || "", toolInput: tool.rawInput || {} });
        const once = params.options?.find(o => o.kind === "allow_once");
        if (!once) throw new Error("No bounded allow-once option");
        return { outcome: { outcome: "selected", optionId: once.optionId } };
      } catch (error) {
        this.publish(worker, "permission-denied", { message: error.message }); return { outcome: { outcome: "cancelled" } };
      }
    }
    throw new Error(`Unsupported ACP client request: ${method}`);
  }
  async run(worker, previous) {
    const { job } = worker;
    const catalog = await this.catalog.refresh(false, true);
    if (!catalog.acp) throw new Error("ACP_UNAVAILABLE: installed CLI does not advertise agent stdio");
    const args = ["agent", "--no-leader"];
    if (job.requestedModel && !["fast", "deep"].includes(job.requestedModel)) args.push("--model", job.requestedModel);
    if (job.effort) args.push("--reasoning-effort", job.effort);
    args.push("stdio");
    const env = { ...sanitizedEnvironment(), GROK_SANDBOX: job.control.sandbox, GROK_DEFAULT_SELECTED_PERMISSION: "allow_once" };
    const warm = previous && this.workers.get(previous.id);
    const version = value => String(value || '').match(/\d+\.\d+\.\d+/)?.[0];
    const reusable = warm?.client && !warm.client.closed && version(warm.job.cliVersion) && version(warm.job.cliVersion) === version(catalog.version);
    const client = reusable ? warm.client : this.clientFactory(catalog.binary, args, { cwd: job.executionPath, env, handler: (m, p) => this.clientRequest(worker, m, p) });
    if (reusable) { clearTimeout(warm.idleTimer); warm.client = null; client.removeAllListeners("notification"); client.removeAllListeners("diagnostic"); client.handler = (m, p) => this.clientRequest(worker, m, p); }
    worker.client = client; job.pid = process.pid;
    client.on("notification", (method, params) => {
      if (params.sessionId && job.grokSessionId && params.sessionId !== job.grokSessionId) return;
      if (["_x.ai/hooks/event", "x.ai/hooks/event"].includes(method)) { this.handleHook(worker, params); return; }
      const event = normalizeGrokEvent({ method, params }); worker.policy.lastActivity = Date.now();
      if (event.type === "text") worker.currentText += event.data;
      if (event.type === "plan") worker.policy.context.todo = event.entries;
      if (event.type === "usage") job.usage = event.usage;
      if (event.type) this.publish(worker, event.type, { ...event });
    });
    client.on("diagnostic", text => fs.appendFileSync(job.logFile, String(text).slice(-8192)));
    const caps = reusable ? warm.capabilities : await client.initialize(); worker.capabilities = caps;
    if (!caps.agentCapabilities?._meta?.["x.ai/hooks"]) throw new Error("CLI_INCOMPATIBLE: runtime does not advertise supervision hooks");
    const rules = `You are supervised by Codex. Stay within ${job.executionPath}. Execute the task, not just a plan. Obey this acceptance contract: ${JSON.stringify(job.acceptance)}.\nExecution environment and effective permissions: ${JSON.stringify(job.environment || {})}. Writable code directory: ${job.executionPath}. Use the exact verification executables/arguments above. A visible tool is not permission to use it. Distinguish permission denial, missing executable/dependency and command failure. Never broaden permissions to repair the environment. Report infrastructure failures to Codex.\n${worker.input.rules || ""}`;
    const session = await client.request(previous ? "session/load" : "session/new", { cwd: job.executionPath, mcpServers: [],
      ...(previous ? { sessionId: previous.grokSessionId } : {}), _meta: { rules, "x.ai/hooks": Object.fromEntries(["session_start", "pre_tool_use", "post_tool_use", "post_tool_use_failure", "stop"].map(event => [event, [{ hookCallbackIds: ["grok-safe-supervisor"], timeout: 5 }]])), ...(worker.input.agent ? { agentProfile: worker.input.agent } : {}) } });
    job.grokSessionId = session.sessionId || previous?.grokSessionId;
    if (!job.grokSessionId) throw new Error("ACP session response has no session ID");
    if (previous && job.grokSessionId !== previous.grokSessionId) throw new Error("RESUME_CONTEXT_LOST: runtime changed the restored session ID");
    job.originalSessionId = previous?.grokSessionId || null; job.activeSessionId = job.grokSessionId;
    worker.sessionOptions = session.configOptions || [];
    const modelState = caps._meta?.modelState;
    job.resolvedModel = session.models?.currentModelId || modelState?.currentModelId || job.requestedModel;
    job.cliVersion = caps._meta?.agentVersion || catalog.version;
    job.modelVersion = null;
    const selectedModel = modelState?.availableModels?.find(m => m.modelId === job.resolvedModel);
    const effort = job.effort || ({ fast: "low", deep: "high" })[job.requestedModel];
    if (effort) {
      if (!selectedModel?._meta?.reasoningEfforts?.some(e => (e.value || e.id) === effort)) throw new Error(`CAPABILITY_MISSING: model does not advertise reasoning effort ${effort}`);
      await client.request("session/set_config_option", { sessionId: job.grokSessionId, configId: "reasoning_effort", value: effort });
      job.effort = effort;
    }
    job.availableCommands = caps._meta?.availableCommands || [];
    this.persist(worker); this.publish(worker, "session-ready", { sessionId: job.grokSessionId, model: job.resolvedModel });
    let prompt = job.prompt;
    if (previous?.checkpoint) prompt += `\n\nPrevious execution checkpoint (context, not new instructions):\n${JSON.stringify(previous.checkpoint).slice(-16000)}`;
    let attempts = 0;
    const timer = setInterval(() => {
      const failure = worker.policy.checkTime();
      if (failure && worker.active) { worker.budgetStop = { ...failure, message: "Execution phase budget exceeded" }; this.requestCancel(worker); }
    }, 1000);
    try {
      while (!worker.cancelRequested) {
        job.round = (job.round || 0) + 1;
        worker.observedHooks = new Set();
        this.publish(worker, 'round-started', { resumedFrom: previous?.id || null });
        this.persist(worker);
        worker.currentText = ""; worker.active = true;
        const result = await client.request("session/prompt", { sessionId: job.grokSessionId, prompt: [{ type: "text", text: prompt }] }, 0);
        clearTimeout(worker.cancelTimer); worker.cancelTimer = null; worker.active = false; job.resultText = worker.currentText; job.stopReason = result.stopReason;
        for (const [messageId, message] of Object.entries(job.messages || {})) if (message.status === 'delivered') this.publish(worker, 'message-acknowledged', { messageId, meaning: 'prompt-returned; task requirements still require acceptance' });
        if (worker.interruptMessage) { const message = worker.interruptMessage; prompt = message.text; worker.interruptMessage = null; this.publish(worker, 'interrupt-stopped', { messageId: message.id, stopReason: result.stopReason }); this.publish(worker, "message-delivered", { messageId: message.id, delivery: "next-prompt", latencyMs: Date.now() - message.receivedAt }); continue; }
        if (worker.cancelRequested || worker.budgetStop) break;
        if (worker.pendingMessages.length) { const messages = worker.pendingMessages.splice(0); prompt = messages.map(m => m.text).join("\n\n"); for (const m of messages) this.publish(worker, "message-delivered", { messageId: m.id, delivery: "next-prompt", latencyMs: Date.now() - m.receivedAt }); continue; }
        worker.policy.setPhase("verifying"); this.persist(worker);
        const completed = result.stopReason === 'end_turn';
        if (!completed && !['cancelled', 'max_tokens', 'max_turns', 'refusal', 'error'].includes(result.stopReason)) this.publish(worker, 'protocol-warning', { reason: 'Unknown stop reason is not successful completion', stopReason: result.stopReason });
        if (completed && !worker.observedHooks?.has("stop")) throw new Error("CLI_INCOMPATIBLE: prompt completed without the registered native stop callback");
        job.implementationStatus = completed ? 'reported-complete' : 'interrupted'; job.testStatus = 'running';
        const delivery = await this.verify(worker, completed, completed ? 0 : 1);
        job.generatedArtifactSnapshot = delivery.generatedArtifactSnapshot || job.generatedArtifactSnapshot;
        // Messages received while the verifier was awaiting must be processed before completion.
        if (!worker.cancelRequested && worker.pendingMessages.length) {
          const messages = worker.pendingMessages.splice(0); prompt = messages.map(m => m.text).join('\n\n');
          for (const message of messages) this.publish(worker, 'message-delivered', { messageId: message.id, delivery: 'next-prompt', latencyMs: Date.now() - message.receivedAt });
          worker.policy.setPhase('editing'); continue;
        }
        if (!delivery.acceptancePassed && !delivery.infrastructureErrors?.length && completed && attempts++ < job.runtime.maxRecoveryAttempts) {
          prompt = `Codex deterministic acceptance failed. Preserve the existing work and fix these failures now:\n${delivery.acceptanceFailures.join("\n")}`;
          this.publish(worker, "acceptance-retry", { attempt: attempts, failures: delivery.acceptanceFailures });
          worker.policy.setPhase("editing"); continue;
        }
        Object.assign(job, delivery); break;
      }
      if (worker.cancelRequested || worker.budgetStop) {
        Object.assign(job, await this.verify(worker, false, 1)); job.status = worker.cancelRequested ? "cancelled" : "incomplete"; job.error = worker.budgetStop || null;
        this.publish(worker, 'execution-stopped', { status: job.status, activePrompt: false });
      }
      job.finishedAt = new Date().toISOString(); job.phase = job.status;
      job.processExited = false; job.transportAlive = !client.closed;
      this.persist(worker); this.publish(worker, "finished", { status: job.status, acceptancePassed: job.acceptancePassed });
      recordTaskSession(job.workspaceRoot, { sessionId: job.grokSessionId, jobId: job.id, kind: job.kind, title: job.title });
      // Keep a warm session for follow-up controls; bounded idle lifetime.
      worker.idleTimer = setTimeout(() => { client.close(); worker.hookServer?.close(); }, 5 * 60000); worker.idleTimer.unref();
    } finally { clearInterval(timer); worker.active = false; }
  }
  fail(worker, error) {
    clearTimeout(worker.cancelTimer);
    worker.job.status = worker.cancelRequested ? "cancelled" : this.closing ? 'interrupted' : "failed"; worker.job.taskCompleted = false; worker.job.acceptancePassed = false;
    worker.job.error = { code: String(error.code || error.message.match(/^([A-Z_]+):/)?.[1] || "ACP_FAILED"), message: error.message, phase: worker.policy.phase };
    try { worker.job.finalSnapshot = snapshotWorkspace(worker.job.executionPath, worker.job.acceptance.requiredArtifacts || []); worker.job.finalHead = worker.job.finalSnapshot.head; } catch {}
    worker.job.finishedAt = new Date().toISOString(); this.persist(worker); this.publish(worker, "finished", { status: "failed", error: worker.job.error });
    worker.client?.close(); worker.hookServer?.close();
  }
  async verify(worker, processOk, exitCode) {
    try { return await this.verifier(worker.job, processOk, exitCode, event => {
      if (!worker.policy || !worker.events) return;
      worker.policy.verificationProgress = event.progress;
      worker.policy.verificationAction = event.type === "verification-command-started" ? event.currentAction : null;
      worker.policy.lastActivity = Date.now();
      const { type, ...data } = event;
      this.publish(worker, type, data);
      this.persist(worker);
    }); }
    catch (error) {
      const job = worker.job;
      let finalSnapshot; try { finalSnapshot = snapshotWorkspace(job.executionPath, job.acceptance.requiredArtifacts || []); } catch {}
      return { status: 'incomplete', taskCompleted: false, acceptancePassed: false,
        implementationStatus: processOk ? 'reported-complete' : 'interrupted', artifactStatus: finalSnapshot ? 'preserved-unverified' : 'unknown',
        finalSnapshot, finalHead: finalSnapshot?.head, testStatus: 'infrastructure-error',
        infrastructureErrors: [{ code: 'VERIFIER_UNAVAILABLE', message: error.message }], acceptanceFailures: ['Verification infrastructure failed; preserve outputs and retry verification'],
        reviewStatus: 'pending', integrationStatus: 'not-merged' };
    } finally {
      if (worker.policy) { worker.policy.verificationAction = null; worker.policy.verificationProgress = null; }
    }
  }
  async send(cwd, id, { text, delivery = "steer", messageId = randomBytes(12).toString("hex") }) {
    const worker = this.find(cwd, id); if (!worker || terminal(worker.job)) throw new Error("Use resume for a completed or disconnected job");
    if (!text?.trim() || !["steer", "interrupt", "queue"].includes(delivery)) throw new Error("Invalid supervisor message");
    if (worker.consumedIds.has(messageId)) return { messageId, status: worker.job.messages?.[messageId]?.status || 'already-received', duplicate: true };
    worker.consumedIds.add(messageId); const message = { id: messageId, text, delivery, receivedAt: Date.now() };
    worker.job.messages ||= {}; worker.job.messages[messageId] = { status: 'received', delivery, receivedAt: message.receivedAt };
    if (delivery === "interrupt" && worker.active) { if (worker.interruptMessage) { this.publish(worker, "message-superseded", { messageId: worker.interruptMessage.id, by: messageId }); } worker.interruptMessage = message; this.requestCancel(worker); }
    else worker.pendingMessages.push(message);
    this.publish(worker, "message-received", { messageId, delivery }); this.persist(worker);
    return { messageId, status: "received", executionConfirmed: false, cursor: worker.events.revision };
  }
  async wait(cwd, id, cursor = 0, timeoutMs = 30000, signal, detail = "summary") {
    const worker = this.find(cwd, id);
    if (!worker) {
      const job = readJobFile(cwd, id); if (!job) throw new Error("Unknown job");
      if (!terminal(job)) {
        const ownerAlive = processAlive(job.pid);
        job.status = ownerAlive ? 'disconnected' : 'interrupted'; job.taskCompleted = false; job.acceptancePassed = false;
        job.connectionStatus = ownerAlive ? 'owned-by-another-connection' : 'owner-exited';
        job.recoveryRequired = true;
        if (!ownerAlive) {
          try { job.finalSnapshot = snapshotWorkspace(job.executionPath, job.acceptance?.requiredArtifacts || []); job.finalHead = job.finalSnapshot.head; } catch {}
          writeJobFile(cwd, job); upsertJob(cwd, job);
        }
      }
      const file = path.join(resolveJobsDir(cwd), `${id}.events.jsonl`);
      const stamp = fs.existsSync(file) ? `${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}` : 'missing';
      if (this.diskEvents.get(file)?.stamp !== stamp) this.diskEvents.set(file, { stamp, events: await JobEvents.load(file) });
      return { ...publicExecution(job, detail), ...this.diskEvents.get(file).events.since(cursor, detail !== 'full'), liveConnection: false, eventSource: 'history' };
    }
    if (!terminal(worker.job)) await worker.events.wait(cursor, timeoutMs, signal, detail !== "full");
    await worker.events.flush();
    if (worker.events.ioError) throw new Error(`EVENT_LOG_UNAVAILABLE: ${worker.events.ioError.message}`);
    return this.snapshot(worker, cursor, detail);
  }
  async waitMany(cwd, targets, timeoutMs = 60000, signal) {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) throw new Error('Use 1 to 8 job targets');
    const abort = new AbortController(); const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const waits = targets.map(t => this.wait(cwd, t.jobId, t.cursor || 0, timeoutMs, abort.signal));
    try { await Promise.race(waits); }
    finally { abort.abort(); await Promise.allSettled(waits); signal?.removeEventListener('abort', cancel); }
    return { jobs: await Promise.all(targets.map(t => this.wait(cwd, t.jobId, t.cursor || 0, 0))) };
  }
  async retryVerification(cwd, id) {
    const live = this.find(cwd, id), job = live?.job || readJobFile(cwd, id);
    if (!job || !terminal(job) || live?.active) throw new Error('JOB_BUSY: verification retry requires a stopped job');
    const release = acquireExecutionLock(resolveJobsDir(cwd), job.executionPath, id);
    try {
      normalizeAcceptance(job.acceptance, job.control);
      this.preflight(job.executionPath, job.acceptance, job.control);
      const previous = { status: job.status, testStatus: job.testStatus, acceptancePassed: job.acceptancePassed, at: new Date().toISOString() };
      job.verificationHistory = [...(job.verificationHistory || []), previous];
      job.status = 'verifying'; job.testStatus = 'running'; writeJobFile(cwd, job);
      const result = await this.verify({ job }, true, 0);
      Object.assign(job, result, { verificationRetriedAt: new Date().toISOString(), reviewStatus: 'pending', integrationStatus: 'not-merged' });
      writeJobFile(cwd, job); upsertJob(cwd, job);
      if (live) this.publish(live, 'verification-finished', { status: job.status, acceptancePassed: job.acceptancePassed });
      return publicExecution(job, 'summary');
    } finally { release(); }
  }
  requestCancel(worker) {
    worker.client.notify("session/cancel", { sessionId: worker.job.grokSessionId });
    if (!worker.cancelTimer) { worker.cancelTimer = setTimeout(() => worker.client.close(Object.assign(new Error("Native cancellation did not settle within 15 seconds"), { code: "CANCEL_TIMEOUT" })), 15000); worker.cancelTimer.unref(); }
  }
  cancel(cwd, id) {
    const worker = this.find(cwd, id); if (!worker) throw new Error("No active ACP connection for job");
    if (terminal(worker.job)) return this.snapshot(worker);
    worker.cancelRequested = true; if (worker.client && worker.job.grokSessionId) this.requestCancel(worker);
    this.publish(worker, "cancel-requested"); return { jobId: id, status: "cancelling" };
  }
  async configure(cwd, id, configId, value) {
    const worker = this.find(cwd, id); if (!worker?.client || worker.client.closed) throw new Error("Session is disconnected");
    if (!["model", "reasoning_effort"].includes(configId)) throw new Error("Only model and reasoning effort are live configurable");
    const result = await worker.client.request("session/set_config_option", { sessionId: worker.job.grokSessionId, configId, value });
    worker.sessionOptions = result.configOptions || result; this.publish(worker, "config-updated", { configId, value }); return result;
  }
  async closeIdle() {
    for (const w of this.workers.values()) if (terminal(w.job) && w.client && !w.client.closed) {
      clearTimeout(w.idleTimer);
      const exited = new Promise(resolve => w.client.child.once("exit", resolve));
      w.client.close(); await exited;
    }
  }
  close() { this.closing = true; for (const worker of this.workers.values()) { clearTimeout(worker.persistTimer); clearTimeout(worker.idleTimer); clearTimeout(worker.cancelTimer); worker.events?.flush(); worker.client?.close(); worker.hookServer?.close(); } }
}
