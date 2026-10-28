// test/smoke-win.mjs - end to end self test for the Windows desktop host.
//
// Side effects: this test never clicks, never types into a pre-existing window,
// and always puts the mouse back where it found it. The only window it types
// into is a notepad it launched itself, after verifying that window is the
// foreground window (it refuses to type otherwise).

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { WinHost } from "../src/win/backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const SCREEN_PNG = path.join(OUT, "screen.png");
const TYPE_TARGET = path.join(OUT, "type-target.txt");
const HOST_SCRIPT = path.join(HERE, "..", "src", "win", "win-host.ps1");
const rows = [];

function push(name, status, msValue, note) { rows.push({ name, status, ms: msValue, note: note || "" }); }
function pass(name, msValue, note) { push(name, "PASS", msValue, note); }
function fail(name, msValue, note) { push(name, "FAIL", msValue, note); }
function skip(name, msValue, note) { push(name, "SKIP", msValue, note); }
function assert(condition, message) { if (!condition) throw new Error(message); }
const sleep = (value) => new Promise((resolve) => setTimeout(resolve, value));

async function step(name, fn) {
  const started = performance.now();
  try { const note = await fn(); pass(name, Math.round(performance.now() - started), note); }
  catch (err) {
    const ms = Math.round(performance.now() - started);
    if (err && err.skipReason) { skip(name, ms, err.skipReason); return; }
    fail(name, ms, (err.code ? err.code + ": " : "") + err.message);
  }
}

/** Bail out of a step with a SKIP row instead of a failure. */
function skipStep(reason) {
  const err = new Error(reason);
  err.skipReason = reason;
  return err;
}

function clampPoint(point, area) { const x0 = area.x || 0; const y0 = area.y || 0; return { x: Math.min(Math.max(x0 + 1, Math.round(point.x)), x0 + area.width - 2), y: Math.min(Math.max(y0 + 1, Math.round(point.y)), y0 + area.height - 2) }; }

async function waitForWindow(host, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  while (Date.now() < deadline) {
    const list = await host.call("windows", {}, { timeoutMs: 20000 });
    const found = (list.windows || []).find(predicate);
    if (found) return found;
    await sleep(300);
  }
  return null;
}

function report() {
  const width = rows.reduce((max, row) => Math.max(max, row.name.length), 5);
  const bar = "-".repeat(width + 44);
  console.log("");
  console.log("STEP".padEnd(width) + "  RESULT   ms     NOTE");
  console.log(bar);
  for (const row of rows) {
    const note = row.note.length > 170 ? row.note.slice(0, 167) + "..." : row.note;
    console.log(row.name.padEnd(width) + "  " + row.status.padEnd(7) + "  " + String(Math.round(row.ms)).padStart(5) + "  " + note);
  }
  console.log(bar);
  const failed = rows.filter((row) => row.status === "FAIL").length;
  const skipped = rows.filter((row) => row.status === "SKIP").length;
  const passed = rows.filter((row) => row.status === "PASS").length;
  console.log("TOTAL: " + passed + " PASS, " + failed + " FAIL, " + skipped + " SKIP");
  return failed;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(TYPE_TARGET, "", "utf8");
  const host = new WinHost();
  const notes = [];
  host.on("event", (message) => { if (message.event === "abort") notes.push("abort: " + JSON.stringify(message.result)); });
  host.on("fatal", (err) => notes.push("fatal: " + err.message));
  let info = null;

  await step("host.start", async () => {
    info = await host.start();
    assert(info && info.dpiAware === true, "host is not DPI aware");
    assert(Array.isArray(info.screens) && info.screens.length > 0, "no screens reported");
    assert(info.inputStructBytes === 40, "sizeof(INPUT)=" + info.inputStructBytes + ", expected 40");
    const main = info.screens[0];
    return "ps=" + info.psVersion + " dpi=" + info.dpiMode + " sta=" + info.apartment + " uia=" + info.uia + " screen=" + main.width + "x" + main.height + "@" + main.scale + " boot=" + info.bootMs + "ms";
  });
  if (!info) { const failed = report(); process.exitCode = failed ? 1 : 0; return; }

  const screen = info.screens[0];
  const vs = info.virtualScreen || { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  let windows = [];
  let target = null;

  await step("screenshot", async () => {
    const shot = await host.call("screenshot", { maxWidth: 1568, maxPixels: 640000 }, { timeoutMs: 20000 });
    assert(shot && shot.image && shot.image.base64, "no image data");
    const buffer = Buffer.from(shot.image.base64, "base64");
    writeFileSync(SCREEN_PNG, buffer);
    assert(buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47, "not a PNG");
    const pixels = shot.image.width * shot.image.height;
    assert(pixels <= 640000, "pixels=" + pixels + " exceeds maxPixels");
    assert(shot.capture && shot.capture.width > 0, "missing capture");
    assert(shot.screen && shot.screen.width > 0, "missing screen");
    assert(typeof shot.scale === "number", "missing scale");
    // First capture of a freshly spawned host: GDI+/codec/JIT warm-up lands here.
    assert(shot.elapsedMs < 1200, "first capture took " + shot.elapsedMs + "ms, budget 1200ms");
    const warmStart = performance.now();
    const warm = await host.call("screenshot", { maxWidth: 1568, maxPixels: 640000 }, { timeoutMs: 20000 });
    const warmMs = Math.round(performance.now() - warmStart);
    assert(warmMs < 600, "warm capture took " + warmMs + "ms, budget 600ms");
    return shot.image.width + "x" + shot.image.height + " (" + pixels + "px) host=" + shot.elapsedMs + "ms scale=" + shot.scale + " " + Math.round(buffer.length / 1024) + "KB -> test/out/screen.png";
  });

  await step("cursor", async () => {
    const cursor = await host.call("cursor", {});
    assert(Number.isFinite(cursor.x) && Number.isFinite(cursor.y), "cursor is not numeric");
    return "x=" + cursor.x + " y=" + cursor.y;
  });

  await step("windows", async () => {
    const list = await host.call("windows", {}, { timeoutMs: 20000 });
    windows = list.windows || [];
    assert(windows.length > 0, "no visible windows");
    const foreground = windows.filter((w) => w.foreground === true);
    assert(foreground.length <= 1, "foreground count=" + foreground.length + ", expected at most 1");
    const required = ["hwnd", "title", "class", "pid", "process", "bounds", "clientBounds", "minimized", "maximized", "foreground", "visible"];
    for (const key of required) assert(Object.prototype.hasOwnProperty.call(windows[0], key), "missing field: " + key);
    const top = foreground[0] || { title: "(untitled foreground, filtered)", pid: 0 };
    return windows.length + " windows, fg=" + JSON.stringify(String(top.title).slice(0, 24)) + " pid=" + top.pid;
  });

  await step("uia", async () => {
    const foreground = windows.find((w) => w.foreground) || windows[0];
    assert(foreground, "no foreground window");
    const tree = await host.call("uia", { hwnd: foreground.hwnd, depth: 4, maxNodes: 400 }, { timeoutMs: 25000 });
    assert(tree && tree.root, "no root");
    assert(tree.nodes > 0, "0 nodes");
    assert(typeof tree.root.role === "string" && tree.root.role.length > 0, "root has no role");
    assert(typeof tree.root.path === "string", "root has no path");
    return tree.nodes + " nodes truncated=" + tree.truncated + " host=" + tree.elapsedMs + "ms root=" + tree.root.role;
  });

  await step("clipboard", async () => {
    const original = await host.call("clipboard", { op: "get" });
    const probe = "dsh-smoke-中文-🚀-" + Date.now();
    try {
      await host.call("clipboard", { op: "set", text: probe });
      const back = await host.call("clipboard", { op: "get" });
      assert(back.text === probe, "roundtrip mismatch: " + JSON.stringify(String(back.text).slice(0, 40)));
    } finally {
      await host.call("clipboard", { op: "set", text: original.text || "" });
    }
    return "roundtrip ok, restored " + String(original.text || "").length + " chars";
  });

  // A desktop can refuse synthetic pointer input (a game in raw-input mode, a
  // mirrored session). The host fails closed on purpose; the input-dependent
  // steps below then report SKIP instead of a false failure.
  let inputBlocked = false;

  await step("mouse move + restore", async () => {
    const origin = await host.call("cursor", {});
    const path1 = [clampPoint({ x: origin.x + 90, y: origin.y + 60 }, vs), clampPoint({ x: origin.x - 120, y: origin.y + 140 }, vs), clampPoint({ x: origin.x + 40, y: origin.y - 80 }, vs)];
    try {
      for (const point of path1) {
        const moved = await host.call("move", { x: point.x, y: point.y, durationMs: 60 });
        assert(Math.abs(moved.x - point.x) <= 2 && Math.abs(moved.y - point.y) <= 2, "move landed at " + moved.x + "," + moved.y + " expected " + point.x + "," + point.y);
      }
    } catch (err) {
      if (String(err.code ?? err.message).includes("POINTER_NOT_LANDED")) {
        inputBlocked = true;
        throw skipStep("desktop swallows synthetic pointer input");
      }
      throw err;
    } finally {
      await host.call("move", { x: origin.x, y: origin.y, durationMs: 60 }).catch(() => {});
    }
    const after = await host.call("cursor", {});
    assert(Math.abs(after.x - origin.x) <= 1 && Math.abs(after.y - origin.y) <= 1, "cursor not restored: " + after.x + "," + after.y + " vs " + origin.x + "," + origin.y);
    return "3 moves, restored to " + origin.x + "," + origin.y;
  });

  await step("window ops (own notepad)", async () => {
    const before = await host.call("windows", {}, { timeoutMs: 20000 });
    const beforeHwnds = new Set((before.windows || []).map((w) => w.hwnd));
    const beforePids = new Set((before.windows || []).map((w) => w.pid));
    const child = spawn("notepad.exe", [TYPE_TARGET], { detached: true, stdio: "ignore" });
    child.unref();
    let ownPid = 0;
    try {
      const fresh = await waitForWindow(host, (w) => !beforeHwnds.has(w.hwnd) && /^notepad/i.test(String(w.process || "")), 12000);
      assert(fresh, "no fresh notepad window appeared");
      ownPid = beforePids.has(fresh.pid) ? 0 : fresh.pid;
      const focused = await host.call("focus", { hwnd: fresh.hwnd });
      assert(focused.bounds && focused.window, "focus result is missing window/bounds");
      if (focused.foreground !== true) {
        throw skipStep("another window holds the foreground lock; focus refused");
      }
      const minimized = await host.call("window", { op: "minimize", hwnd: fresh.hwnd });
      assert(minimized.minimized === true, "minimize did not report minimized");
      const restored = await host.call("window", { op: "restore", hwnd: fresh.hwnd });
      assert(restored.minimized === false, "restore did not clear minimized");
      let gone = false;
      try { await host.call("focus", { hwnd: 2147483647 }); } catch (err) { gone = err.code === "WINDOW_GONE"; }
      assert(gone, "focus on a bogus hwnd did not answer WINDOW_GONE");
      const closed = await host.call("window", { op: "close", hwnd: fresh.hwnd });
      assert(closed.closed === true, "WM_CLOSE did not close the clean notepad");
      return "focus+minimize+restore+close ok, WINDOW_GONE ok (pid " + fresh.pid + ")";
    } finally {
      if (ownPid) { try { process.kill(ownPid); } catch { } }
    }
  });

  await step("type chinese (own notepad)", async () => {
    if (inputBlocked) throw skipStep("desktop swallows synthetic input");
    const before = await host.call("windows", {}, { timeoutMs: 20000 });
    const beforeHwnds = new Set((before.windows || []).map((w) => w.hwnd));
    const beforePids = new Set((before.windows || []).map((w) => w.pid));
    const child = spawn("notepad.exe", [TYPE_TARGET], { detached: true, stdio: "ignore" });
    child.unref();
    let ownPid = 0;
    try {
      const fresh = await waitForWindow(host, (w) => !beforeHwnds.has(w.hwnd) && /^notepad/i.test(String(w.process || "")), 12000);
      if (!fresh) throw new Error("no fresh notepad window appeared; refused to type into an existing window");
      ownPid = beforePids.has(fresh.pid) ? 0 : fresh.pid;
      const focused = await host.call("focus", { hwnd: fresh.hwnd });
      assert(focused.foreground === true, "notepad is not foreground; refusing to type");
      const text = "你好 DeepSeek 🚀 中文输入 ok";
      const typed = await host.call("type", { text }, { timeoutMs: 20000 });
      assert(typed.chars === text.length, "type reported " + typed.chars + " units, expected " + text.length);
      await sleep(250);
      await host.call("key", { keys: ["ctrl", "a"] });
      await host.call("key", { keys: ["ctrl", "c"] });
      await sleep(150);
      const clip = await host.call("clipboard", { op: "get" });
      assert(clip.text === text, "notepad text = " + JSON.stringify(String(clip.text).slice(0, 50)) + ", expected " + JSON.stringify(text));
      return typed.chars + " UTF-16 units typed, verified via ctrl+a/ctrl+c (pid " + fresh.pid + ")";
    } finally {
      if (ownPid) { try { process.kill(ownPid); } catch { } }
      else { try { await host.call("clipboard", { op: "set", text: "" }); } catch { } }
    }
  });

  await step("perf: 200x cursor", async () => {
    const total = 200;
    const started = performance.now();
    for (let index = 0; index < total; index++) await host.call("cursor", {}, { timeoutMs: 10000 });
    const resident = performance.now() - started;
    const average = resident / total;
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const oneShotStart = performance.now();
      spawnSync(host.powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", HOST_SCRIPT], { input: "{\"id\":\"1\",\"cmd\":\"cursor\",\"args\":{}}\n{\"id\":\"2\",\"cmd\":\"shutdown\",\"args\":{}}\n", encoding: "utf8", windowsHide: true, timeout: 90000 });
      samples.push(performance.now() - oneShotStart);
    }
    const oneShot = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    assert(average < oneShot, "resident average " + average.toFixed(2) + "ms is not below per-call spawn " + oneShot.toFixed(1) + "ms");
    return total + " calls in " + Math.round(resident) + "ms, avg " + average.toFixed(2) + "ms vs one-shot process " + Math.round(oneShot) + "ms (" + (oneShot / average).toFixed(1) + "x faster)";
  });

  await step("host.close", async () => {
    await host.close();
    assert(host.isReady === false, "host still reports ready after close");
    assert(host.proc === null, "process handle not released");
    return "graceful shutdown";
  });

  const failed = report();
  if (notes.length) console.log("NOTES: " + notes.join("; "));
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error("smoke test crashed: " + err.stack); process.exitCode = 1; });
