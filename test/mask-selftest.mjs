// Privacy mask: masked pixels must never reach the attachment, the frame diff or
// the OCR engine, and a tool call must not be able to turn the mask off.
//
// Side effects: captures the screen only. Nothing is clicked or typed.
// Run: node test/mask-selftest.mjs

import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'

const ctx = { get: () => undefined, logger: { info() {}, error() {} }, effect: (fn) => fn() }
let pass = 0
let fail = 0
function check(name, ok, note) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}
function skip(name, why) { console.log('SKIP  ' + name + '  (' + why + ')') }

const EVERYTHING = { x: -20000, y: -20000, width: 40000, height: 40000 }

// 1. config normalisation drops rectangles that cannot be drawn.
const cleaned = normalizeConfig({ maskRegions: [{ x: 1, y: 2, width: 0, height: 5 }, { x: '10', y: 20, width: 100, height: 50 }, 'nope'] })
check('mask regions are sanitised at config time',
  cleaned.maskRegions.length === 1 && cleaned.maskRegions[0].x === 10 && cleaned.maskRegions[0].width === 100,
  JSON.stringify(cleaned.maskRegions))

// 2. a masked capture reports the mask and paints the pixels out.
const rt = new ComputerRuntime(ctx, normalizeConfig({ maskRegions: [EVERYTHING], overlay: 'never', uiSummary: 'none' }))
try {
  const shot = await rt.capture({})
  check('capture reports how many regions it masked', shot.masked >= 1, 'masked=' + shot.masked)
  check('the text warns the model that pixels are hidden', /privacy-masked/.test(shot.text), shot.text.split('\n').find((l) => /privacy-masked/.test(l)))

  // 3. everything masked -> two frames are identical, so the diff must be quiet.
  const first = await rt.capture({ compare: true })
  const second = await rt.capture({ compare: true })
  const change = second.change ?? {}
  check('a fully masked screen is diff-stable', change.comparable === true && change.changed === false, JSON.stringify(change))

  // 4. OCR reads the same masked PNG, so a mask over everything hides all text.
  try {
    const seen = await rt.recognize({})
    check('a fully masked screen yields no OCR text', (seen.lines ?? []).length === 0, 'lines=' + (seen.lines ?? []).length)
  } catch (cause) {
    skip('fully masked OCR', 'OCR unavailable here: ' + String(cause?.message ?? cause).slice(0, 80))
  }

  // 5. a tool cannot opt out of the mask by passing its own rectangles.
  const raw = await rt.call('screenshot', { mask: null, maxWidth: 400 })
  check('a call that passes mask:null still gets the configured mask', raw.image?.masked >= 1, 'masked=' + raw.image?.masked)
} finally {
  await rt.dispose()
}

// 6. with no configured mask, the very same capture is not masked.
const plain = new ComputerRuntime(ctx, normalizeConfig({ overlay: 'never', uiSummary: 'none' }))
try {
  const shot = await plain.capture({})
  check('no config means no mask', shot.masked === 0, 'masked=' + shot.masked)
} finally {
  await plain.dispose()
}

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
