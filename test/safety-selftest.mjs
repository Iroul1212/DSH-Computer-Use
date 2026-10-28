// Safety-contract regression test for the computer-use plugin.
// Run: node test/safety-selftest.mjs

import { execSync } from "node:child_process";
import { ComputerRuntime, normalizeConfig, ToolError } from "../src/runtime.js";
import { createComputerTool } from "../src/tools.js";

let passed = 0;
let failed = 0;

function check(name, ok, evidence) {
  if (ok) { passed += 1; console.log("PASS  " + name + "  [" + evidence + "]"); }
  else { failed += 1; console.log("FAIL  " + name + "  [" + evidence + "]"); }
}

// No attachments service: screenshots fall back to spilling to disk, which is the
// documented degradation path for deployments without an attachment store.
function makeCtx() {
  return { get: () => undefined, logger: { info() {}, error() {} }, effect: (fn) => fn() };
}

function makeRuntime(overrides) {
  const config = normalizeConfig(overrides || {});
  const runtime = new ComputerRuntime(makeCtx(), config);
  const tool = createComputerTool(runtime, config);
  return { config, runtime, tool };
}

async function expectReject(promise) {
  try {
    const value = await promise;
    return { rejected: false, value };
  } catch (err) {
    return { rejected: true, code: (err && err.code) || null, message: String((err && err.message) || err) };
  }
}

function countPwsh() {
  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq pwsh.exe\" /NH", { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes("pwsh.exe")).length;
  } catch { return -1; }
}

const pwshBefore = countPwsh();
console.log("pwsh processes before: " + pwshBefore);
console.log("");

// 1. dry run must not touch the desktop and must not count a mutation.
async function test1() {
  const { runtime, tool } = makeRuntime({ dryRun: true, coordinates: "physical" });
  try {
    const before = await runtime.call("cursor", {});
    const m0 = runtime.mutations;
    const result = await tool.execute({ action: "move", x: 100, y: 100 });
    const after = await runtime.call("cursor", {});
    const cursorSame = before.x === after.x && before.y === after.y;
    check("1. dry run does not touch desktop",
      result.dryRun === true && runtime.mutations === m0 && cursorSame,
      "dryRun=" + result.dryRun + " mutations=" + m0 + "->" + runtime.mutations +
      " cursor=" + before.x + "," + before.y + "->" + after.x + "," + after.y);
  } finally { await runtime.dispose(); }
}

// 2. a mutating action must arm the visible indicator; disarm must take it down.
async function test2() {
  const { runtime, tool } = makeRuntime({ overlay: "always", coordinates: "physical" });
  let origin = null;
  try {
    origin = await runtime.call("cursor", {});
    await tool.execute({ action: "move", x: origin.x, y: origin.y });
    const armed = runtime.overlayArmed === true;
    const state = runtime.guardState;
    await runtime.disarmOverlay();
    check("2. overlay arms on mutating action",
      armed && state === "armed" && runtime.overlayArmed === false,
      "afterMove.armed=" + armed + " guardState=" + state + " afterDisarm.armed=" + runtime.overlayArmed);
  } finally {
    if (origin) await runtime.call("move", { x: origin.x, y: origin.y, durationMs: 0 }).catch(() => {});
    await runtime.dispose();
  }
}


// 3. read-only actions must never raise the indicator.
// 3a. overlay "auto" (default): read-only never arms; the next mutating action does.
async function test3a() {
  const { runtime, tool } = makeRuntime({ overlay: "auto", coordinates: "physical" });
  let origin = null;
  try {
    origin = await runtime.call("cursor", {});
    const statusR = await expectReject(tool.execute({ action: "status" }));
    const cursorR = await expectReject(tool.execute({ action: "cursor" }));
    const shotR = await expectReject(tool.execute({ action: "screenshot" }));
    const afterReads = runtime.overlayArmed;
    await tool.execute({ action: "move", x: origin.x, y: origin.y });
    const afterMutate = runtime.overlayArmed;
    await runtime.disarmOverlay();
    check("3a. overlay=auto: read-only does not arm, mutating does",
      afterReads === false && afterMutate === true && runtime.overlayArmed === false,
      "afterReads.armed=" + afterReads + " afterMutate.armed=" + afterMutate +
      " afterDisarm.armed=" + runtime.overlayArmed +
      " status=" + (statusR.rejected ? statusR.code : "ok") +
      " cursor=" + (cursorR.rejected ? cursorR.code : "ok") +
      " screenshot=" + (shotR.rejected ? shotR.code : "ok"));
  } finally {
    if (origin) await runtime.call("move", { x: origin.x, y: origin.y, durationMs: 0 }).catch(() => {});
    await runtime.disarmOverlay().catch(() => {});
    await runtime.dispose();
  }
}

// 3b. overlay "always": the documented contract is the opposite - ANY desktop use,
// including a read-only cursor poll, must raise the indicator.
async function test3b() {
  const { runtime, tool } = makeRuntime({ overlay: "always", coordinates: "physical" });
  try {
    const before = runtime.overlayArmed;
    const cursorR = await expectReject(tool.execute({ action: "cursor" }));
    const armed = runtime.overlayArmed;
    const state = runtime.guardState;
    check("3b. overlay=always: read-only arms the indicator",
      before === false && !cursorR.rejected && armed === true && state === "armed",
      "before.armed=" + before + " afterReadOnlyCursor.armed=" + armed +
      " guardState=" + state + " (documented: always = visible for any desktop use)");
  } finally {
    await runtime.disarmOverlay().catch(() => {});
    await runtime.dispose();
  }
}

// 4. after Esc every mutating action fails closed; reads stay available.
async function test4() {
  const { runtime, tool } = makeRuntime({ coordinates: "physical", overlay: "never" });
  try {
    runtime.handleEsc({ reason: "escape", at: new Date().toISOString() });
    const click = await expectReject(tool.execute({ action: "click", x: 10, y: 10 }));
    const shot = await expectReject(tool.execute({ action: "screenshot" }));
    const status = await expectReject(tool.execute({ action: "status" }));
    const hit = click.rejected && /STOPPED_BY_HUMAN|pressed Esc/i.test(String(click.code) + " " + click.message);
    check("4. after Esc mutating fails closed, reads still allowed",
      hit && !shot.rejected && !status.rejected,
      "click=" + (click.rejected ? click.code : "RESOLVED(ok)") +
      " screenshot=" + (shot.rejected ? shot.code : "ok") +
      " status=" + (status.rejected ? status.code : "ok"));
  } finally { await runtime.dispose(); }
}

// 5. resume needs a cooling-off window; only a fresh human decision resumes.
async function test5() {
  const { runtime, tool } = makeRuntime({ coordinates: "physical", overlay: "never" });
  try {
    runtime.handleEsc({ reason: "escape", at: new Date().toISOString() });
    const early = await expectReject(tool.execute({ action: "resume" }));
    runtime.tripped.at = new Date(Date.now() - 6000).toISOString();
    const late = await expectReject(tool.execute({ action: "resume" }));
    check("5. resume cooldown then clears kill switch",
      early.rejected && early.code === "RESUME_TOO_SOON" && !late.rejected && runtime.tripped === null,
      "early=" + (early.rejected ? early.code : "RESOLVED") +
      " late=" + (late.rejected ? late.code : "ok") + " tripped=" + String(runtime.tripped));
  } finally { await runtime.dispose(); }
}

// 6. blocklist must reject before anything is typed.
async function test6() {
  const { runtime, tool } = makeRuntime({ blocklist: ["vault"], coordinates: "physical", overlay: "never" });
  try {
    const typed = await expectReject(tool.execute({ action: "type", text: "vault password" }));
    check("6. blocklist rejects matching target",
      typed.rejected && typed.code === "BLOCKED_TARGET",
      "type=" + (typed.rejected ? typed.code : "RESOLVED(ok)") + " mutations=" + runtime.mutations);
  } finally { await runtime.dispose(); }
}

// 7. a dead host must surface as rejection, never as a silent ok.
async function test7() {
  const { runtime, tool } = makeRuntime({ coordinates: "physical", overlay: "never" });
  try {
    await runtime.call("cursor", {});
    await runtime.host.close();
    await new Promise((r) => setTimeout(r, 600));
    const noticed = runtime.host === null || runtime.hostState !== "ready";
    const probe = await expectReject(runtime.call("cursor", {}));
    console.log("      info: after host.close() hostState=" + runtime.hostState +
      " noticedDeath=" + noticed +
      " readProbe=" + (probe.rejected ? "rejected(" + probe.code + ")" : "auto-restarted"));
    if (runtime.host && typeof runtime.host.close === "function") { await runtime.host.close().catch(() => {}); }
    runtime.host = null;
    runtime.ensureHost = async () => { throw new ToolError("BACKEND_START_FAILED", "simulated: windows host crashed and cannot restart"); };
    const click = await expectReject(tool.execute({ action: "click", x: 10, y: 10 }));
    check("7. host crash fails closed (never silent ok)",
      noticed && click.rejected,
      "hostDied=" + noticed + " click=" + (click.rejected ? click.code : "RESOLVED(ok)"));
  } finally { await runtime.dispose(); }
}

// 8. the visible indicator dying on its own must freeze mutating actions.
async function test8() {
  const { runtime, tool } = makeRuntime({ overlay: "always", coordinates: "physical" });
  try {
    const origin = await runtime.call("cursor", {});
    await tool.execute({ action: "move", x: origin.x, y: origin.y });
    const armed = runtime.overlayArmed === true && runtime.guard !== null;
    runtime.guard.emit("exit", { unexpected: true });
    const reason = runtime.tripped ? runtime.tripped.reason : null;
    const click = await expectReject(tool.execute({ action: "click", x: 10, y: 10 }));
    const shot = await expectReject(tool.execute({ action: "screenshot" }));
    const hit = click.rejected && /STOPPED_BY_HUMAN|pressed Esc/i.test(String(click.code) + " " + click.message);
    check("8. guard killed -> fail closed",
      armed && reason === "guard-exited" && hit && !shot.rejected,
      "armed=" + armed + " tripped.reason=" + reason +
      " click=" + (click.rejected ? click.code : "RESOLVED(ok)") +
      " screenshot=" + (shot.rejected ? shot.code : "ok"));
  } finally {
    if (runtime.guard && typeof runtime.guard.disarm === "function") await runtime.guard.disarm().catch(() => {});
    await runtime.dispose();
  }
}

// 9. the automation host dying on its own must freeze mutating actions.
async function test9() {
  const { runtime, tool } = makeRuntime({ overlay: "never", coordinates: "physical" });
  let host = null;
  try {
    await runtime.call("cursor", {});
    host = runtime.host;
    const restarts0 = runtime.hostRestarts;
    host.emit("exit", { expected: false, code: 1 });
    const reason = runtime.tripped ? runtime.tripped.reason : null;
    const restarts = runtime.hostRestarts - restarts0;
    const click = await expectReject(tool.execute({ action: "click", x: 10, y: 10 }));
    const hit = click.rejected && /STOPPED_BY_HUMAN|pressed Esc/i.test(String(click.code) + " " + click.message);
    check("9. host crashed -> fail closed",
      reason === "host-exited" && restarts === 1 && hit,
      "tripped.reason=" + reason + " hostRestarts+=" + restarts +
      " runtime.host=" + String(runtime.host) +
      " click=" + (click.rejected ? click.code : "RESOLVED(ok)"));
  } finally {
    if (host && typeof host.close === "function") await host.close().catch(() => {});
    await runtime.dispose();
  }
}

// 10. window drift guard: a stale observation must never turn into a real click.
async function test10() {
  const { runtime, tool } = makeRuntime({});
  try {
    const wins = (await runtime.call("windows", {})).windows || [];
    const target = wins.find((w) => w.visible === true && w.bounds && w.bounds.width > 200) || wins[0];
    const view = await runtime.capture({ hwnd: target.hwnd });
    const recorded = runtime.lastView ? runtime.lastView.window : null;
    const cap = (view.view && view.view.capture) || {};
    const boundsMatch = !!recorded && !!recorded.bounds &&
      recorded.bounds.x === cap.x && recorded.bounds.y === cap.y &&
      recorded.bounds.width === cap.width && recorded.bounds.height === cap.height;
    // Simulate the window being dragged 37px right; only the recorded value changes.
    const driftable = !!recorded && !!recorded.bounds;
    if (driftable) recorded.bounds.x += 37;
    const mutationsBefore = runtime.mutations;
    const click = await expectReject(tool.execute({ action: "click", x: 5, y: 5 }));
    const blocked = click.rejected && /TARGET_WINDOW_MOVED/.test(String(click.code) + " " + click.message);
    const noMutation = runtime.mutations === mutationsBefore;
    const shot = await expectReject(tool.execute({ action: "screenshot" }));
    check("10. window moved -> mutating blocked, reads still ok",
      boundsMatch && driftable && blocked && noMutation && !shot.rejected,
      "lastView.window.bounds=" + JSON.stringify(recorded && recorded.bounds) +
      " capture=" + JSON.stringify(cap) +
      " click=" + (click.rejected ? click.code : "RESOLVED(ok)") +
      " mutations=" + mutationsBefore + "->" + runtime.mutations +
      " screenshot=" + (shot.rejected ? shot.code : "ok"));
  } finally {
    await runtime.dispose();
  }
}

async function main() {
  await test1();
  await test2();
  await test3a();
  await test3b();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  await test10();
  await new Promise((r) => setTimeout(r, 800));
  const pwshAfter = countPwsh();
  console.log("");
  console.log("pwsh processes after: " + pwshAfter + " (before " + pwshBefore + ", delta " + (pwshAfter - pwshBefore) + ")");
  console.log("");
  if (failed === 0) {
    console.log("PASS " + passed + " passed");
    process.exitCode = 0;
  } else {
    console.log("FAIL " + failed + " failed, " + passed + " passed");
    process.exitCode = 1;
  }
  process.exit(process.exitCode);
}

main().catch((err) => {
  console.log("FAIL  harness crashed: " + String((err && err.stack) || err));
  process.exit(1);
});

