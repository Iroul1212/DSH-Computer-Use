// End-to-end check for the overlay guard: arm -> ready -> synthetic Esc -> abort.
// Run: node test\\overlay-selftest.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Guard, isSupported } from "../src/overlay/guard.mjs";

function resolvePwsh() {
  const candidates = [
    process.env.DSH_PWSH,
    "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe",
    "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "pwsh";
}

/** Fire a real Esc down/up through keybd_event so GetAsyncKeyState sees it. */
function pressEscape() {
  const script = [
    `$sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'`,
    `$t = Add-Type -MemberDefinition $sig -Name Kbd -Namespace W -PassThru`,
    `$t::keybd_event(0x1B, 0, 0, [System.UIntPtr]::Zero)`,
    `Start-Sleep -Milliseconds 90`,
    `$t::keybd_event(0x1B, 0, 2, [System.UIntPtr]::Zero)`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const p = spawn(resolvePwsh(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("keybd_event failed: " + err))));
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for " + label)), ms)),
  ]);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
}

async function main() {
  if (!isSupported()) {
    console.log("SKIP  not win32");
    process.exit(0);
  }

  const guard = new Guard();
  const readyP = new Promise((resolve) => guard.once("ready", resolve));
  await guard.arm({ mode: "both" });
  const ready = await withTimeout(readyP, 5000, "ready event");
  const st = guard.status();

  check("arm() sets armed=true", st.armed === true, "armed=" + st.armed);
  check("ready carries hwnd/bounds/pid",
    typeof ready.hwnd === "number" && ready.hwnd > 0 &&
    !!ready.bounds && ready.bounds.width > 0 && ready.bounds.height > 0 &&
    typeof ready.pid === "number",
    "hwnd=" + ready.hwnd + " bounds=" + ready.bounds.width + "x" + ready.bounds.height + " pid=" + ready.pid);
  check("status() shape matches protocol",
    typeof st.armed === "boolean" && typeof st.tripped === "boolean" &&
    (st.reason === null || typeof st.reason === "string") &&
    (st.since === null || typeof st.since === "string"),
    JSON.stringify(st));

  const st2 = await guard.arm({ mode: "both" });
  check("repeated arm() is idempotent", st2.armed === true && st2.tripped === false, "armed=" + st2.armed);

  const abortP = new Promise((resolve) => guard.once("abort", resolve));
  await pressEscape();
  const abort = await withTimeout(abortP, 8000, "abort event");

  check("abort event received", !!abort, JSON.stringify(abort));
  check("abort.reason is escape", abort.reason === "escape", "reason=" + abort.reason);
  check("abort.at is ISO8601", typeof abort.at === "string" && !Number.isNaN(Date.parse(abort.at)), "at=" + abort.at);

  await new Promise((r) => setTimeout(r, 1500));
  const st3 = guard.status();
  check("status().tripped === true", st3.tripped === true, JSON.stringify(st3));
  check("status().armed === false", st3.armed === false, "armed=" + st3.armed);
  check("tripped is sticky on re-read", guard.status().tripped === true);

  await guard.disarm();
  check("disarm() leaves armed=false", guard.status().armed === false);
  check("reset() clears tripped", guard.reset().tripped === false);

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(failed.length === 0
    ? "RESULT: PASS (" + results.length + "/" + results.length + " checks)"
    : "RESULT: FAIL (" + failed.length + " of " + results.length + " checks failed)");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log("FAIL  " + (err && err.message ? err.message : String(err)));
  console.log("RESULT: FAIL (exception)");
  process.exit(1);
});

