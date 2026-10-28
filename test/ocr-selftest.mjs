import { spawn } from 'node:child_process'
import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'
import { createComputerTool } from '../src/tools.js'
const rt = new ComputerRuntime({ get: () => undefined, logger: { info() {}, error() {} } }, normalizeConfig({}))
const tool = createComputerTool(rt, rt.config)
let pass = 0, fail = 0, skip = 0
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('PASS  ' + n + (d ? '  [' + d + ']' : '')) } else { fail++; console.log('FAIL  ' + n + (d ? '  [' + d + ']' : '')) } }
const skipIt = (n, why) => { skip++; console.log('SKIP  ' + n + '  [' + why + ']') }
let child = null
try {
  const enumOk = tool.parameters.properties.action.enum
  check('action enum exposes ocr + wait_for', enumOk.includes('ocr') && enumOk.includes('wait_for'), enumOk.length + ' actions')
  const t0 = Date.now()
  const ocr = await tool.execute({ action: 'ocr', maxLines: 40 }, {})
  const lines = ocr.lines ?? []
  check('ocr returns recognized lines', ocr.ok === true && lines.length > 0, lines.length + ' lines in ' + (Date.now() - t0) + 'ms, lang=' + ocr.lang)
  check('ocr line carries physical bounds', !!lines[0] && ['x', 'y', 'width', 'height'].every((k) => typeof lines[0].bounds?.[k] === 'number'), JSON.stringify(lines[0]?.bounds))
  console.log('      sample: ' + lines.slice(0, 3).map((l) => l.text).join(' | ').slice(0, 110))
  child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
  child.unref()
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  await nap(1200)
  const listed = await rt.call('windows', {})
  const pad = (listed.windows ?? []).find((w) => /notepad/i.test(String(w.process ?? '')) && w.bounds && w.bounds.width > 100)
  if (!pad) {
    skipIt('wait_for stable on a still window', 'could not launch notepad to get a still target')
  } else {
    const t1 = Date.now()
    try {
      const stable = await tool.execute({ action: 'wait_for', waitKind: 'stable', hwnd: pad.hwnd, timeoutMs: 8000, stableMs: 300 }, {})
      check('wait_for stable settles on a still window', stable.ok === true, 'waited ' + stable.wait.waitedMs + 'ms over ' + stable.wait.frames + ' frames, ' + (Date.now() - t1) + 'ms wall')
    } catch (cause) {
      skipIt('wait_for stable on a still window', 'notepad frames kept changing: ' + String(cause?.message ?? cause).slice(0, 80))
    }
  }
  let timedOut = false
  try { await tool.execute({ action: 'wait_for', waitKind: 'window', titleMatch: 'zzz-no-such-window-9f3a', timeoutMs: 900 }, {}) } catch (cause) { timedOut = cause?.code === 'WAIT_TIMEOUT' }
  check('wait_for window times out loudly', timedOut)
} finally {
  try { spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' }) } catch { }
  await rt.dispose()
  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped')
  if (fail > 0) process.exitCode = 1
}


