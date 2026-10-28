// test/observe-selftest.mjs - the "did it work?" layer: screenshot decorations
// (grid / mark / dim), the frame diff behind `compare` / `verify`, and the
// pointer verification that stops a click from landing silently off-target.
//
// Side effects: captures a window it does not own, and moves the pointer once
// (restored at the end). Nothing is clicked and nothing is typed.
//
// Run: node test/observe-selftest.mjs

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WinHost } from '../src/win/backend.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const rows = []

function check(name, ok, note) {
  rows.push({ name, ok })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (note ? '  (' + note + ')' : ''))
}
function skip(name, note) {
  console.log('SKIP  ' + name + (note ? '  (' + note + ')' : ''))
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A paint-stable window to diff against: not the foreground one, not minimized. */
function pickTarget(windows) {
  const usable = windows.filter((w) => {
    const b = w.bounds ?? {}
    return !w.minimized && !w.foreground && b.width >= 320 && b.height >= 240 && !/^BongoCat/i.test(w.title ?? '')
  })
  usable.sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))
  return usable[0] ?? null
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP  not win32')
    process.exit(0)
  }
  const host = new WinHost({ log: () => {} })
  await host.start()
  try {
    const list = await host.call('windows', {})
    const target = pickTarget(list.windows ?? [])
    assert(target, 'no capturable window on this desktop')
    const hwnd = target.hwnd
    const base = { hwnd, maxWidth: 640 }

    // 1. the first comparison of a target has nothing to compare against.
    const first = await host.call('screenshot', { ...base, compare: true })
    assert(first.image?.change, 'a compare capture must carry a change object')
    check('first compare capture is not comparable',
      first.image.change.comparable === false,
      'change=' + JSON.stringify(first.image.change))

    // 2. a second capture of the same target produces a verdict.
    const second = await host.call('screenshot', { ...base, compare: true })
    const c2 = second.image?.change ?? {}
    assert(c2.comparable === true, 'second compare capture must be comparable')
    check('second capture reports a verdict',
      typeof c2.changed === 'boolean' && c2.ratio >= 0 && c2.ratio <= 1,
      'changed=' + c2.changed + ' ratio=' + c2.ratio + ' sample=' + c2.sample)

    const direct = !first.fallback && !second.fallback
    if (!direct) {
      skip('decoration / diff isolation', 'window capture fell back to the whole screen')
    } else {
      // 3. decorations must never be part of the diff: darken nearly the whole
      //    frame, and the very next comparison must still see "almost nothing".
      const dimmed = await host.call('screenshot', { ...base, compare: true, dim: { x: 2, y: 2, width: 2, height: 2 } })
      check('dim decorates the image', dimmed.image?.decorated === true)
      check('decorations are excluded from the diff',
        (dimmed.image?.change?.ratio ?? 0) < 0.25,
        'ratio after dimming the frame=' + dimmed.image?.change?.ratio)

      const afterDim = await host.call('screenshot', { ...base, compare: true })
      check('a decorated frame never becomes the diff reference',
        (afterDim.image?.change?.ratio ?? 0) < 0.25,
        'ratio after undecorated recapture=' + afterDim.image?.change?.ratio)

      // 4. grid + mark decorate too, and stay out of the diff as well.
      const grid = await host.call('screenshot', { ...base, compare: true, grid: true, gridStep: 100, mark: { x: 120, y: 90 } })
      check('grid and mark decorate the image',
        grid.image?.decorated === true && (grid.image?.change?.ratio ?? 0) < 0.25,
        'ratio=' + grid.image?.change?.ratio)
    }

    // 5. a different target is never diffed against this one.
    const other = (list.windows ?? []).find((w) => w.hwnd !== hwnd && !w.minimized && (w.bounds?.width ?? 0) >= 320)
    if (other) {
      const cross = await host.call('screenshot', { hwnd: other.hwnd, maxWidth: 640, compare: true })
      check('a different window is not diffed against this one',
        cross.image?.change?.comparable === false,
        'comparable=' + cross.image?.change?.comparable)
    } else {
      skip('cross-target diff', 'only one usable window')
    }

    // 6. pointer verification: either the pointer really lands, or the host
    //    refuses with a machine-readable POINTER_NOT_LANDED. Never silence.
    const before = await host.call('cursor', {})
    const goal = { x: Math.max(0, Math.round((before.x + 120) % 1200)), y: Math.max(0, Math.round((before.y + 80) % 700)) }
    try {
      const moved = await host.call('move', { x: goal.x, y: goal.y, durationMs: 40 })
      const receipt = moved.pointer ?? {}
      check('a successful move carries a landed receipt',
        receipt.landed === true && Math.abs(moved.x - goal.x) <= 2 && Math.abs(moved.y - goal.y) <= 2,
        'goal=' + goal.x + ',' + goal.y + ' actual=' + moved.x + ',' + moved.y + ' drift=' + receipt.drift)
    } catch (err) {
      const code = err?.code ?? err?.payload?.code ?? ''
      check('a swallowed pointer move fails closed',
        code === 'POINTER_NOT_LANDED' && /captur/i.test(String(err.message)),
        code + ': ' + String(err.message).slice(0, 120))
    }
    try { await host.call('move', { x: before.x, y: before.y, durationMs: 30 }) } catch { /* pointer may be captured */ }
  } finally {
    await host.close()
  }

  const failed = rows.filter((r) => !r.ok).length
  console.log('')
  console.log(failed === 0 ? 'PASS  ' + rows.length + ' checks' : 'FAIL  ' + failed + ' of ' + rows.length + ' checks')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('FAIL  ' + (err && err.message ? err.message : String(err)))
  process.exit(1)
})
