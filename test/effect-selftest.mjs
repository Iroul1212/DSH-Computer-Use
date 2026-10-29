// Silent-failure guards: an action that visibly did nothing must not report ok.
// Run: node test/effect-selftest.mjs

import { createComputerTool } from '../src/tools.js'
import { normalizeConfig } from '../src/runtime.js'

let pass = 0
let fail = 0
const check = (name, ok, note) => {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}

const WINDOW = { hwnd: 11, pid: 100, title: 'Schematic', process: 'PLECS' }
const OTHER = { hwnd: 22, pid: 200, title: 'Library Browser', process: 'PLECS' }
const FOREIGN = { hwnd: 33, pid: 300, title: 'Untitled - Notepad4', process: 'Notepad4' }

function fakeRuntime({ changed, foreground = WINDOW, config = {} }) {
  const calls = []
  const runtime = {
    config: normalizeConfig({ verifyActions: 'fail', actionDelayMs: 0, overlay: 'never', ...config }),
    lastView: { window: WINDOW, foreground },
    skillCatalog: () => [],
    captureCount: 0,
    log() {},
    toPhysical: (x, y) => ({ x, y }),
    async beforeMutation() { return { dryRun: false } },
    async assertPointerTarget() { return null },
    async call(cmd, args) {
      calls.push(cmd)
      if (cmd === 'drag') return { from: args.from, to: args.to, pointer: { drift: 0 } }
      if (cmd === 'type') return { chars: String(args.text ?? '').length }
      return { ok: true }
    },
    async capture() {
      runtime.captureCount += 1
      return {
        change: { changed, ratio: changed ? 0.2 : 0, region: null },
        view: { foreground, window: WINDOW, width: 100, height: 100 },
        cursor: { x: 1, y: 1 },
      }
    },
    calls,
  }
  return runtime
}

const tool = createComputerTool(fakeRuntime({ changed: true }), normalizeConfig({}))

async function expectCode(name, fn, code) {
  try {
    const res = await fn()
    check(name, false, 'resolved with ok=' + res?.ok)
  } catch (cause) {
    check(name, cause?.code === code, cause?.code + ': ' + String(cause?.message ?? '').slice(0, 70))
  }
}

// A drop that changed nothing is a missed drop.
{
  const rt = fakeRuntime({ changed: false })
  const t = createComputerTool(rt, rt.config)
  await expectCode('a drag that changes nothing raises DROP_MISSED',
    () => t.execute({ action: 'drag', x: 10, y: 10, toX: 40, toY: 40 }), 'DROP_MISSED')
}

// The same drag with a visible change is fine.
{
  const rt = fakeRuntime({ changed: true })
  const t = createComputerTool(rt, rt.config)
  const res = await t.execute({ action: 'drag', x: 10, y: 10, toX: 40, toY: 40 })
  check('a drag that changes the screen stays ok', res.ok === true && res.change?.changed === true)
}

// Typing that changed nothing went into the void.
{
  const rt = fakeRuntime({ changed: false })
  const t = createComputerTool(rt, rt.config)
  await expectCode('typing that changes nothing raises TYPE_MISSED',
    () => t.execute({ action: 'type', text: 'C:\\Users\\x\\buck.plecs' }), 'TYPE_MISSED')
}

// Typing while another app owns the foreground is refused, even if pixels moved.
{
  const rt = fakeRuntime({ changed: true, foreground: FOREIGN })
  const t = createComputerTool(rt, rt.config)
  try {
    await t.execute({ action: 'type', text: 'hello' })
    check('typing into another app raises TYPE_MISSED', false, 'resolved')
  } catch (cause) {
    check('typing into another app raises TYPE_MISSED',
      cause?.code === 'TYPE_MISSED' && /foreground is/.test(String(cause.message)),
      String(cause?.message ?? '').slice(0, 70))
  }
}

// Keys: a no-op key is normal, a stolen foreground is not.
{
  const rt = fakeRuntime({ changed: false, foreground: WINDOW })
  const t = createComputerTool(rt, rt.config)
  const res = await t.execute({ action: 'key', keys: ['ctrl', 'c'] })
  check('a key that changes nothing stays ok (ctrl+c)', res.ok === true)
}
{
  const rt = fakeRuntime({ changed: true, foreground: FOREIGN })
  const t = createComputerTool(rt, rt.config)
  await expectCode('keys sent to another window raise KEY_MISSED',
    () => t.execute({ action: 'key', keys: ['ctrl', 's'] }), 'KEY_MISSED')
}

// warn keeps ok:true, off does not even capture.
{
  const rt = fakeRuntime({ changed: false, config: { verifyActions: 'warn' } })
  const t = createComputerTool(rt, rt.config)
  const res = await t.execute({ action: 'drag', x: 10, y: 10, toX: 40, toY: 40 })
  check('verifyActions=warn returns ok with a warning', res.ok === true && !!res.warning, String(res.warning ?? '').slice(0, 50))
}
{
  const rt = fakeRuntime({ changed: false, config: { verifyActions: 'off' } })
  const t = createComputerTool(rt, rt.config)
  const res = await t.execute({ action: 'drag', x: 10, y: 10, toX: 40, toY: 40 })
  check('verifyActions=off skips the extra capture', res.ok === true && rt.captureCount === 0)
}

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
