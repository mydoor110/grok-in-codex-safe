import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

/** Multiplexed NDJSON transport: server requests never steal prompt responses. */
export class AcpClient extends EventEmitter {
  constructor(binary, args = ["agent", "--no-leader", "stdio"], options = {}) {
    super();
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    this.handler = options.handler || (async method => { throw new Error(`Unsupported client method: ${method}`); });
    this.child = spawn(binary, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8"); let buffer = "";
    this.child.stdout.on("data", data => {
      buffer += decoder.write(data);
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return this.close(new Error("ACP frame exceeds limit"));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)).catch(error => this.close(error)); } catch { this.emit("diagnostic", "Discarded malformed ACP frame"); }
      }
    });
    this.child.stdin.on("error", error => this.close(error));
    this.child.stderr.on("data", data => this.emit("diagnostic", data.toString("utf8")));
    this.child.on("error", error => this.close(error));
    this.child.on("exit", (code, signal) => this.close(new Error(`ACP process exited (${code ?? signal})`)));
  }
  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error("ACP connection is closed");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(Object.assign(new Error(`ACP request timed out: ${method}`), { code: "ACP_TIMEOUT" }));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) { this.send({ method, params }); }
  async receive(message) {
    if (message.method) {
      if (message.id === undefined) { this.emit("notification", message.method, message.params || {}); return; }
      try {
        const result = await this.handler(message.method, message.params || {});
        this.send({ id: message.id, result });
      } catch (error) {
        if (!this.closed) this.send({ id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || "ACP error"), { code: message.error.code, data: message.error.data }));
    else pending.resolve(message.result);
  }
  async initialize() {
    this.capabilities = await this.request("initialize", { protocolVersion: 1,
      clientInfo: { name: "grok-safe", version: "1" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
    if (this.capabilities?.protocolVersion !== 1) throw Object.assign(new Error('ACP_PROTOCOL_UNSUPPORTED: expected protocolVersion=1'), { code: 'ACP_PROTOCOL_UNSUPPORTED' });
    return this.capabilities;
  }
  close(error = new Error("ACP connection closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.child.kill(); this.emit("closed", error);
  }
}
