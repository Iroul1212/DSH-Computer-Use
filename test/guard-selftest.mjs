// Pointer guards discovered during the PLECS run: a click must not silently land
// on another application, and a point outside the window the model last looked at
// must not be clicked or dragged through.
// Run: node test/guard-selftest.mjs

import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'
import { createComputerTool } from '../src/tools.js'

const ctx = { get: () => undefined, logger: { info() {}, error() {}, warn() {} }, effect: (fn) => fn() }
let pass = 0
let fail = 0
function check(name, ok, note) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}
function skip(name, why) { console.log('SKIP  ' + name + '  (' + why + ')') }

const cfg = normalizeConfig({ coordinates: 'physical', overlay: 'never', uiSummary: 'none', actionDelayMs: 0 })
const rt = new ComputerRuntime(ctx, cfg)
const tool = createComputerTool(rt, cfg)
try {
  const wins = (await rt.call('windows', {})).windows ?? []
  const target = wins.find((w) => !w.minimized && w.bounds && w.bounds.width >= 300 && w.bounds.height >= 200)
  if (!target) {
    skip('pointer guards', 'no usable window on this desktop')
  } else {
    await rt.capture({ hwnd: target.hwnd })
    check('a window capture records the window as the expected target',
      rt.lastView?.window?.hwnd === target.hwnd, 'hwnd=' + target.hwnd)

    // 1. outside the window the model just looked at -> refused before any input.
    let outside = null
    try {
      await tool.execute({ action: 'click', x: target.bounds.x - 40, y: target.bounds.y - 40 })
    } catch (cause) { outside = cause }
    check('a click outside the pinned window is refused',
      outside?.code === 'OUTSIDE_TARGET_WINDOW', outside?.code ?? 'resolved')

    // 2. inside the window but over another application -> refused with the culprit named.
    const x0 = target.bounds.x
    const y0 = target.bounds.y
    const w = target.bounds.width
    const h = target.bounds.height
    let foreign = null
    for (let i = 1; i <= 6 && !foreign; i += 1) {
      for (let j = 1; j <= 6 && !foreign; j += 1) {
        const px = Math.round(x0 + (w * i) / 7)
        const py = Math.round(y0 + (h * j) / 7)
        const at = await rt.call('windowat', { x: px, y: py }).catch(() => null)
        if (at && at.pid && at.pid !== target.pid) foreign = { px, py, at }
      }
    }
    if (!foreign) {
      // No overlapping foreign window on this desktop: prove the comparison itself
      // with a stub, so the guard cannot rot unnoticed.
      const realCall = rt.call.bind(rt)
      rt.call = async (cmd, args, options) => (cmd === 'windowat'
        ? { hwnd: 999999, title: 'Some other app', process: 'other', pid: target.pid + 4242 }
        : realCall(cmd, args, options))
      let wrong = null
      try { await tool.execute({ action: 'click', x: Math.round(x0 + w / 2), y: Math.round(y0 + h / 2) }) } catch (cause) { wrong = cause }
      rt.call = realCall
      check('a click over another application is refused',
        wrong?.code === 'CLICK_WRONG_WINDOW' && /would deliver the click there/i.test(String(wrong.message)),
        wrong ? wrong.code + ': ' + String(wrong.message).slice(0, 90) : 'resolved')
    } else {
      let wrong = null
      try { await tool.execute({ action: 'click', x: foreign.px, y: foreign.py }) } catch (cause) { wrong = cause }
      check('a click over another application is refused',
        wrong?.code === 'CLICK_WRONG_WINDOW' && /would deliver the click there/i.test(String(wrong.message)),
        wrong ? wrong.code + ': ' + String(wrong.message).slice(0, 90) : 'resolved')
    }
  }
} finally {
  await rt.dispose()
}

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
