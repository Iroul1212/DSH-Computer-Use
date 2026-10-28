// DeepSeek Harness computer-use safety layer: the guard that owns the visible
// overlay process and turns a global Esc press into an abort event.
//
// Node ESM. See README.md next to this file and notes/win-host-protocol.md.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PS1 = path.join(HERE, 'overlay.ps1');

export const DEFAULT_MESSAGE = 'DeepSeek Harness 正在操控你的电脑 · 按 Esc 停止';
export const READY_TIMEOUT_MS = 20000;

/** Overlay indicator + global Esc kill-switch is only meaningful on Windows. */
export function isSupported() {
  return process.platform === 'win32';
}

function resolvePwsh() {
  const env = process.env.DSH_PWSH;
  if (env && existsSync(env)) return env;
  const candidates = [
    'C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe',
    'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'pwsh';
}

export class Guard extends EventEmitter {
  constructor() {
    super();
    this._child = null;
    this._arming = null;
    this._armed = false;
    this._tripped = false;
    this._reason = null;
    this._since = null;
    this._readyInfo = null;
    this._expectedExit = false;
    this._stderrTail = '';
    this._stdoutBuf = '';
  }

  /** Guard result shape, as fixed by notes/win-host-protocol.md (guard cmd). */
  status() {
    return {
      armed: this._armed,
      tripped: this._tripped,
      reason: this._reason,
      since: this._since,
    };
  }

  /**
   * Start the overlay. Idempotent: calling it again while already armed just
   * returns the current status. Resolves once the overlay reported ready.
   */
  async arm(opts = {}) {
    if (this._armed) return this.status();
    if (this._arming) return this._arming;

    if (!isSupported()) {
      this._reason = 'unsupported';
      throw new Error('Guard.arm(): overlay is only supported on win32');
    }
    if (!existsSync(OVERLAY_PS1)) {
      this._reason = 'overlay-missing';
      throw new Error('Guard.arm(): overlay.ps1 not found at ' + OVERLAY_PS1);
    }

    this._arming = this._start(opts);
    try {
      return await this._arming;
    } finally {
      this._arming = null;
    }
  }


  async _start(opts) {
    const {
      message = DEFAULT_MESSAGE,
      opacity = 1,
      mode = "both",
      autoCloseSeconds = 0,
      disableHotkey = false,
    } = opts || {};

    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", OVERLAY_PS1,
      "-Message", String(message),
      "-Opacity", String(opacity),
      "-Mode", String(mode),
    ];
    if (autoCloseSeconds > 0) args.push("-AutoCloseSeconds", String(autoCloseSeconds));
    if (disableHotkey) args.push("-DisableHotkey");

    this._expectedExit = false;
    this._stderrTail = "";
    this._stdoutBuf = "";
    this._reason = null;

    const child = spawn(resolvePwsh(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this._child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-4000);
      this.emit("stderr", chunk);
    });

    // One durable exit listener. This is what guarantees the guard is never
    // silently left looking \\"still armed\\" after the overlay process died.
    child.on("exit", (code, signal) => {
      if (this._child === child) this._child = null;
      if (this._armed) {
        this._armed = false;
        if (!this._tripped) this._reason = "overlay-exited";
      }
      this.emit("exit", {
        code,
        signal,
        unexpected: !this._expectedExit && !this._tripped,
        reason: this._reason,
      });
    });

    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._reason = "overlay-timeout";
        try { child.kill(); } catch (e) { /* ignore */ }
        const tail = this._stderrTail.trim();
        reject(new Error("Guard.arm(): overlay did not report ready within " +
          READY_TIMEOUT_MS + "ms" + (tail.length > 0 ? " :: " + tail : "")));
      }, READY_TIMEOUT_MS);


      child.stdout.on("data", (chunk) => {
        this._stdoutBuf += chunk;
        let idx;
        while ((idx = this._stdoutBuf.indexOf("\n")) >= 0) {
          const line = this._stdoutBuf.slice(0, idx).trim();
          this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
          if (!line) continue;

          let msg;
          try {
            msg = JSON.parse(line);
          } catch (e) {
            // Anything non-JSON on stdout is an overlay bug; surface it.
            this.emit("log", line);
            continue;
          }
          this._handleEvent(msg, {
            resolveReady: (info) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(info);
            },
          });
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._reason = "overlay-spawn-failed";
        reject(err);
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._reason = "overlay-exited";
        const tail = this._stderrTail.trim();
        reject(new Error("Guard.arm(): overlay exited before ready (code=" + code +
          " signal=" + signal + ")" + (tail.length > 0 ? " :: " + tail : "")));
      });
    });

    const info = await ready;
    this._armed = true;
    this._readyInfo = info;
    this._since = new Date().toISOString();
    return this.status();
  }

  _handleEvent(msg, ctx = {}) {
    if (msg && msg.event === "ready") {
      this.emit("ready", msg.result || {});
      if (ctx.resolveReady) ctx.resolveReady(msg.result || {});
      return;
    }
    if (msg && msg.event === "abort") {
      const result = msg.result || {};
      this._tripped = true;          // sticky until reset()
      this._armed = false;
      this._reason = result.reason || "escape";
      this._since = result.at || new Date().toISOString();
      this.emit("abort", { reason: this._reason, at: this._since });
      return;
    }
    if (msg && msg.event === "selftest") {
      this.emit("selftest", msg.result || {});
      return;
    }
    this.emit("event", msg);
  }

  /** Stop the overlay. Safe to call when already stopped. */
  async disarm() {
    const child = this._child;
    this._armed = false;
    if (!child) return this.status();

    this._expectedExit = true;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once("exit", finish);
      try { child.kill(); } catch (e) { finish(); }
      setTimeout(() => {
        if (done) return;
        try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
        finish();
      }, 3000);
    });
    this._child = null;
    return this.status();
  }

  /** Clear the sticky tripped flag so a new arm() starts clean. */
  reset() {
    this._tripped = false;
    this._reason = null;
    this._since = null;
    this._expectedExit = false;
    return this.status();
  }

  get readyInfo() { return this._readyInfo; }
}

let _singleton = null;
/** Process-wide single guard, so two plugin call sites cannot race two overlays. */
export function getGuard() {
  if (!_singleton) _singleton = new Guard();
  return _singleton;
}

export default Guard;

