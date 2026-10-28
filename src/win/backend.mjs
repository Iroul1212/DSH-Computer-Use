// src/win/backend.mjs - Node client for the DeepSeek Harness Windows desktop host.
// Spawns win-host.ps1 once and speaks NDJSON over stdin/stdout.
// Protocol contract: notes/win-host-protocol.md

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.join(HERE, "win-host.ps1");
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"];

export function findPowerShell(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_PWSH && existsSync(process.env.DSH_PWSH)) return process.env.DSH_PWSH;
  const candidates = [
    path.join(process.env.ProgramFiles || "C:/Program Files", "PowerShell/7/pwsh.exe"),
    "C:/Program Files/PowerShell/7/pwsh.exe",
    path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  ];
  for (const candidate of candidates) { if (candidate && existsSync(candidate)) return candidate; }
  return "powershell.exe";
}

export class WinHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.scriptPath = options.scriptPath || DEFAULT_SCRIPT;
    this.powershell = findPowerShell(options.powershell);
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
    this.restartLimit = options.restartLimit ?? 1;
    this.proc = null;
    this.isReady = false;
    this.hostInfo = null;
    this._seq = 0;
    this._pending = new Map();
    this._abandoned = new Set();
    this._chain = Promise.resolve();
    this._starting = null;
    this._out = "";
    this._stderr = "";
    this._closing = false;
    this._restarts = 0;
    this._readyWaiters = [];
  }

  get pid() { return this.proc ? this.proc.pid : null; }
  get screens() { return (this.hostInfo && this.hostInfo.screens) || []; }
  stderrTail(chars = 1200) { return this._stderr.slice(-chars).trim(); }

  start() {
    if (this.proc && this.isReady) return Promise.resolve(this.hostInfo);
    if (!this._starting) {
      this._starting = new Promise((resolve, reject) => { this._spawn(resolve, reject); })
        .finally(() => { this._starting = null; });
    }
    return this._starting;
  }

  _spawn(resolve, reject) {
    const args = [...PS_FLAGS, this.scriptPath];
    let proc;
    try {
      proc = spawn(this.powershell, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) { reject(err); return; }
    this.proc = proc;
    this._out = "";
    this._stderr = "";

    const timer = setTimeout(() => {
      reject(new Error("win-host not ready within " + this.readyTimeoutMs + "ms; stderr tail: " + this.stderrTail()));
    }, this.readyTimeoutMs);
    this._readyWaiters.push((info) => { clearTimeout(timer); resolve(info); });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => this._onStderr(chunk));
    proc.stdin.on("error", () => { /* host died; exit handler reports it */ });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code, signal) => this._onExit(code, signal));
  }

  _onStdout(chunk) {
    this._out += chunk;
    let index = this._out.indexOf("\n");
    while (index >= 0) {
      const line = this._out.slice(0, index).replace(/\r$/, "");
      this._out = this._out.slice(index + 1);
      if (line.trim()) this._handleLine(line);
      index = this._out.indexOf("\n");
    }
  }

  _onStderr(chunk) {
    this._stderr = (this._stderr + chunk).slice(-20000);
    this.emit("stderr", chunk);
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", { level: "warn", message: "non-JSON stdout from win-host: " + line.slice(0, 300) });
      return;
    }
    if (message && typeof message === "object" && message.event) {
      if (message.event === "ready") {
        this.isReady = true;
        this.hostInfo = message.result;
        const waiters = this._readyWaiters;
        this._readyWaiters = [];
        for (const waiter of waiters) { try { waiter(message.result); } catch { } }
      }
      this.emit("event", message);
      return;
    }
    const id = message ? message.id : undefined;
    if (id === undefined || id === null) return;
    const entry = this._pending.get(id);
    if (!entry) {
      // Late response for a timed-out (or abandoned) request: drop it by design.
      if (this._abandoned.has(id)) this._abandoned.delete(id);
      return;
    }
    this._pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    const error = new Error((message.error && message.error.message) || "win-host command failed");
    error.code = (message.error && message.error.code) || "HOST_ERROR";
    error.detail = message.error || null;
    error.cmd = entry.cmd;
    entry.reject(error);
  }

  call(cmd, args = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const run = () => this._request(cmd, args, timeoutMs);
    // Serial queue: one request in flight at a time, but a timeout never blocks the queue.
    const next = this._chain.then(run, run);
    this._chain = next.then(() => undefined, () => undefined);
    return next;
  }

  _request(cmd, args, timeoutMs) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      return Promise.reject(this._exitError(null, null));
    }
    const id = "r" + (++this._seq);
    const payload = JSON.stringify({ id, cmd, args }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._abandoned.add(id);
        const error = new Error("win-host timeout after " + timeoutMs + "ms (cmd=" + cmd + ")");
        error.code = "TIMEOUT";
        const tail = this.stderrTail();
        if (tail) error.stderrTail = tail;
        reject(error);
      }, Math.max(1, timeoutMs));
      this._pending.set(id, { resolve, reject, timer, cmd });
      try {
        this.proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _exitError(code, signal) {
    const error = new Error("win-host exited (code=" + code + ", signal=" + signal + ")");
    error.code = "HOST_EXIT";
    const tail = this.stderrTail();
    if (tail) error.stderrTail = tail;
    return error;
  }

  _onExit(code, signal) {
    const proc = this.proc;
    this.isReady = false;
    this.proc = null;
    const error = this._exitError(code, signal);
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
    this.emit("exit", { code, signal, restarts: this._restarts, expected: this._closing });
    if (this._closing) return;
    if (this._restarts < this.restartLimit) {
      this._restarts += 1;
      this.emit("restart", { attempt: this._restarts, code, signal });
      // The fresh host announces itself with a ready event, which is re-emitted
      // through the event stream so callers can refresh geometry / info.
      this.start().catch((err) => this.emit("fatal", err));
      return;
    }
    this.emit("fatal", error);
    if (this.listenerCount("fatal") === 0) { /* nobody listening: stay quiet */ }
  }

  async restart() {
    this._closing = false;
    if (this.proc) {
      const proc = this.proc;
      this._closing = true;
      try { proc.kill(); } catch { }
      await new Promise((resolve) => { proc.once("exit", resolve); setTimeout(resolve, 1000); });
      this._closing = false;
    }
    this._restarts += 1;
    return this.start();
  }

  async close(options = {}) {
    const killAfterMs = options.killAfterMs ?? 2000;
    const proc = this.proc;
    if (!proc) { this._closing = true; return; }
    this._closing = true;
    try { await this.call("shutdown", {}, { timeoutMs: 1500 }); }
    catch { /* host already gone or hung: fall through to kill */ }
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { try { proc.kill(); } catch { } resolve(); }, killAfterMs);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.proc = null;
    this.isReady = false;
  }
}

export default WinHost;

export function createHost(options = {}) {
  return new WinHost(options);
}
