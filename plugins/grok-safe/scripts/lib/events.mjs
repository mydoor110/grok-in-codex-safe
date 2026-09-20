import fs from "node:fs";
import { EventEmitter } from "node:events";
import readline from 'node:readline';

// Only suppress known routine telemetry. Unknown events and failures remain visible.
// Heartbeats are supervision events so a long-running command can wake grok_wait.
export function supervisionEvent(event) {
  if (event.error || ["failed", "error", "denied", "blocked", "cancelled"].includes(event.status) || (event.exitCode != null && event.exitCode !== 0)) return true;
  if (event.type === "heartbeat") return true;
  return !["text", "thought", "hook", "usage", "tool_call", "tool_call_update", "tool-start"].includes(event.type)
    && !(event.type === "command-finished" && event.exitCode === 0);
}

function rememberImportant(store, event, maxEntries) {
  if (!supervisionEvent(event)) return;
  if (event.type === "heartbeat") {
    const idx = store.important.findLastIndex(item => item.type === "heartbeat");
    if (idx >= 0) store.important.splice(idx, 1);
  }
  store.important.push(event);
  if (store.important.length > maxEntries) store.importantDroppedThrough = store.important.shift().revision;
}

export class JobEvents extends EventEmitter {
  static async load(file, maxEntries = 256) {
    const result = new JobEvents(undefined, maxEntries);
    if (!fs.existsSync(file)) return result;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      result.revision = Math.max(result.revision, event.revision || 0);
      result.entries.push({ ...event, replayed: true }); if (result.entries.length > maxEntries) result.entries.shift();
      rememberImportant(result, { ...event, replayed: true }, maxEntries);
    }
    return result;
  }
  constructor(file, maxEntries = 256) {
    super(); this.file = file; this.entries = []; this.revision = 0; this.maxEntries = maxEntries;
    this.important = []; this.importantDroppedThrough = 0;
    if (file && fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      for (const line of lines) { try { this.entries.push(JSON.parse(line)); } catch {} }
      this.revision = this.entries.at(-1)?.revision || 0;
      this.important = [];
      this.importantDroppedThrough = 0;
      for (const event of this.entries) rememberImportant(this, event, maxEntries);
      this.entries = this.entries.slice(-maxEntries);
    }
  }
  publish(type, data = {}) {
    const event = { ...data, revision: ++this.revision, type, timestamp: new Date().toISOString(), replayed: false };
    this.entries.push(event); if (this.entries.length > this.maxEntries) this.entries.shift();
    rememberImportant(this, event, this.maxEntries);
    if (this.file) {
      this.buffer ||= []; this.buffer.push(`${JSON.stringify(event)}\n`);
      if (!this.scheduled) this.scheduled = setImmediate(() => { this.scheduled = null; this.flush(); });
    }
    this.emit("event", event); return event;
  }
  flush() {
    if (this.buffer?.length) {
      const text = this.buffer.join(''); this.buffer = [];
      this.writing = (this.writing || Promise.resolve()).then(() => fs.promises.appendFile(this.file, text)).catch(error => { this.ioError = error; });
    }
    return this.writing || Promise.resolve();
  }
  since(cursor = 0, importantOnly = false) {
    const pending = (importantOnly ? this.important : this.entries).filter(e => e.revision > cursor);
    const selected = importantOnly ? pending.slice(0, 24) : pending;
    const more = selected.length < pending.length;
    return { cursor: more ? selected.at(-1).revision : this.revision, hasMore: more,
      gap: importantOnly ? cursor < this.importantDroppedThrough : cursor < (this.entries[0]?.revision || 1) - 1,
      events: selected.map(event => importantOnly && JSON.stringify(event).length > 600 ?
        { revision: event.revision, type: event.type, timestamp: event.timestamp, round: event.round, replayed: event.replayed,
          detailsOmitted: true, evidenceRevision: event.revision, instruction: 'Read this revision from eventsFile before resolving this event.' } : event) };
  }
  wait(cursor = 0, timeoutMs = 30000, signal, importantOnly = false) {
    const snapshot = () => this.since(cursor, importantOnly);
    if (snapshot().events.length || snapshot().gap || timeoutMs === 0) return Promise.resolve(snapshot());
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.off("event", onEvent); signal?.removeEventListener("abort", finish); resolve(snapshot()); };
      const onEvent = event => { if (!importantOnly || supervisionEvent(event)) finish(); };
      const timer = setTimeout(finish, Math.min(timeoutMs, 60000));
      this.on("event", onEvent); signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}

/** Current ACP, Messages JSON, and the older text stream share one representation. */
export function normalizeGrokEvent(message) {
  const event = message.params?.update || message.update || message;
  const type = event.sessionUpdate || event.type;
  if (["agent_message_chunk", "agent_thought_chunk"].includes(type)) return { type: type === "agent_message_chunk" ? "text" : "thought", data: event.content?.text || "" };
  if (type === "tool_call" || type === "tool_call_update") return { type, id: event.toolCallId || event.id, name: event.title || event.tool || event.name,
    kind: event.kind, status: event.status, input: event.rawInput || event.input, output: event.rawOutput, locations: event.locations, content: event.content };
  if (type === "plan") return { type: "plan", entries: event.entries || [] };
  if (type === "usage_update") return { type: "usage", usage: event };
  if (type === "content_block_delta") return { type: event.delta?.type === "thinking_delta" ? "thought" : "text", data: event.delta?.text || event.delta?.thinking || "" };
  return type ? { ...event, type } : { type: 'protocol-notification', method: message.method, payload: event };
}
