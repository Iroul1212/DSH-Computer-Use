// The computer-use pointer: the host can swap the system arrow for a blue one and
// put the user's own cursor scheme back. This test always restores, even on failure.
// Run: node test/cursor-selftest.mjs

import { WinHost } from '../src/win/backend.mjs'
import { normalizeConfig } from '../src/runtime.js'

let pass = 0
let fail = 0
function check(name, ok, note) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}

check('cursor defaults to the agent arrow', normalizeConfig({}).cursor === 'agent', normalizeConfig({}).cursor)
check('cursor accepts halo only', normalizeConfig({ cursor: 'halo' }).cursor === 'halo')
check('an unknown cursor value falls back', normalizeConfig({ cursor: 'nope' }).cursor === 'agent', normalizeConfig({ cursor: 'nope' }).cursor)

const host = new WinHost({ log: () => {} })
await host.start()
try {
  const applied = await host.call('cursorstyle', { mode: 'agent' })
  check('the agent cursor is installed', applied.applied === true, JSON.stringify(applied))
  const restored = await host.call('cursorstyle', { mode: 'system' })
  check('the user cursor scheme is restored', restored.restored === true, JSON.stringify(restored))
} catch (cause) {
  check('cursor style round trip', false, String(cause?.message ?? cause).slice(0, 120))
} finally {
  try { await host.call('cursorstyle', { mode: 'system' }) } catch { /* best effort */ }
  await host.close()
}

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
