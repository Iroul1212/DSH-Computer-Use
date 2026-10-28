/**
 * Offline self-test for dsh-computer-use.
 *
 * Runs without the DSH host: a fake cordis context stands in for the harness, so
 * this checks exactly two things and nothing else —
 *
 * 1. the tool layer: `apply` registers the four tools, and every tool carries a
 *    usable JSON-Schema contract, a value renderer and an `execute`;
 * 2. the real desktop, when the Windows backend exists: one real screenshot and
 *    one real window enumeration through {@link ComputerRuntime}.
 *
 * It never clicks, never types and never mutates the desktop. If
 * `src/win/backend.mjs` is not there yet (it is written by another module), the
 * real-desktop steps report SKIP and the tool-layer steps still have to pass.
 *
 * Run with: node test/plugin-selftest.mjs
 * Exit code: 0 only when every non-skipped step passed.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'
import { createComputerTool } from '../src/tools.js'
import { apply, inject, name } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED = ['computer', 'app_skill', 'app_window', 'ui_element', 'clipboard']
const rows = []
let failed = 0

/**
 * Run one assertion step, timing it and recording PASS/FAIL.
 * @param label - short step name for the table.
 * @param fn - the step body; may return a short note for the table.
 * @returns {Promise<void>}
 */
async function step(label, fn) {
  const started = performance.now()
  try {
    const note = await fn()
    rows.push({ status: 'PASS', label, note: note ?? '', ms: performance.now() - started })
  } catch (cause) {
    failed += 1
    rows.push({
      status: 'FAIL',
      label,
      note: String(cause?.message ?? cause).split('\n')[0].slice(0, 160),
      ms: performance.now() - started,
    })
  }
}

/** Record a step that could not run in this checkout. */
function skip(label, note) {
  rows.push({ status: 'SKIP', label, note, ms: 0 })
}

/** Throw unless `condition` holds. */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * A cordis-context stand-in: just enough surface for `apply` and the runtime.
 * `get` resolves no services, so attachments fall back to disk.
 * @returns the fake context plus the arrays it collects into.
 */
function makeCtx() {
  const collected = []
  const effects = []
  return {
    collected,
    effects,
    tools: {
      register(tool) {
        collected.push(tool)
        return () => {}
      },
    },
    get: () => undefined,
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    effect(fn) {
      effects.push(fn)
    },
  }
}

const ctx = makeCtx()
await step('apply registers 5 tools', async () => {
  apply(ctx, {})
  const names = ctx.collected.map((tool) => tool.name)
  assert(ctx.collected.length === 5, `expected 5 tools, got ${ctx.collected.length} (${names.join(', ')})`)
  assert(names.join(',') === EXPECTED.join(','), `expected ${EXPECTED.join(', ')}, got ${names.join(', ')}`)
  assert(typeof apply === 'function' && inject.includes('tools') && name === 'computer-use', 'plugin metadata is wrong')
  assert(typeof apply === 'function', 'apply must be a named export')
  assert(ctx.effects.length >= 1, 'apply registered no ctx.effect disposer')
  return names.join(' ')
})

for (const tool of ctx.collected) {
  await step(`${tool.name}: json-schema contract`, async () => {
    const params = tool.parameters
    assert(params && params.type === 'object', 'parameters.type must be "object"')
    assert(Array.isArray(params.required) && params.required.length > 0, 'parameters.required must be a non-empty array')
    assert(params.additionalProperties === undefined, 'the root schema must not carry additionalProperties')
    assert(params.required.includes('action'), 'every tool must require action')
    assert(params.properties && Object.keys(params.properties).length > 0, 'parameters.properties must be non-empty')
    assert(typeof tool.execute === 'function', 'execute must be a function')
    assert(typeof tool.output?.render === 'function', 'output.render must be a function')
    assert(typeof tool.presentCall === 'function', 'presentCall must be a function')
    assert(typeof tool.description === 'string' && tool.description.length > 40, 'description is missing or too short')
    for (const key of params.required) assert(params.properties[key], `required param "${key}" has no property definition`)
    return `${Object.keys(params.properties).length} params, required: ${params.required.join(',')}`
  })
}

await step('computer: action enum', async () => {
  const tool = ctx.collected.find((t) => t.name === 'computer')
  const action = tool?.parameters?.properties?.action
  assert(action, 'computer has no `action` parameter')
  assert(Array.isArray(action.enum), 'computer `action` has no enum')
  for (const needed of ['screenshot', 'click', 'type', 'resume']) {
    assert(action.enum.includes(needed), `computer \`action\` enum is missing "${needed}"`)
  }
  return `${action.enum.length} actions`
})

/**
 * A runtime stand-in that records what the tool layer asks for, so the
 * verification plumbing can be tested without a desktop.
 * @returns a fake ComputerRuntime-shaped object.
 */
function makeFakeRuntime() {
  const calls = []
  const captures = []
  const rt = {
    config: normalizeConfig({ actionDelayMs: 0 }),
    lastView: { width: 800, height: 600, scale: 0.5, capture: { x: 0, y: 0, width: 1600, height: 1200 } },
    tripped: null,
    mutations: 0,
    hostState: 'ready',
    overlayArmed: false,
    overlayError: null,
    calls,
    captures,
    skillCatalog: () => 'excel: test',
    skillFor: () => null,
    toPhysical: (x, y) => ({ x: x == null ? null : Math.round(x / 0.5), y: y == null ? null : Math.round(y / 0.5) }),
    async beforeMutation() { return { dryRun: false } },
    async call(cmd, args) { calls.push({ cmd, args }); return { x: 11, y: 22, chars: 3, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } } },
    async capture(options = {}) {
      captures.push(options)
      return {
        action: 'screenshot',
        ok: true,
        text: 'capture',
        view: rt.lastView,
        change: options.compare === true
          ? { comparable: true, changed: true, ratio: 0.12, bounds: { x: 1, y: 2, width: 30, height: 40 }, sample: '256x160' }
          : null,
      }
    },
  }
  return rt
}

await step('computer: decorations + verify plumbing', async () => {
  const fake = makeFakeRuntime()
  const tool = createComputerTool(fake, fake.config)
  const props = tool.parameters.properties
  for (const key of ['grid', 'gridStep', 'mark', 'dim', 'compare', 'verify']) {
    assert(props[key], 'computer is missing the ' + key + ' parameter')
  }

  await tool.execute({ action: 'screenshot', grid: true, gridStep: 120, mark: { x: 10, y: 20 }, dim: { x: 1, y: 2, width: 300, height: 200 }, compare: true })
  const shotArgs = fake.captures[0]
  assert(shotArgs.grid === true && shotArgs.gridStep === 120, 'grid/gridStep were not forwarded')
  assert(shotArgs.mark?.x === 10 && shotArgs.dim?.width === 300, 'mark/dim were not forwarded')
  assert(shotArgs.compare === true, 'compare was not forwarded')

  const clicked = await tool.execute({ action: 'click', x: 100, y: 200, verify: true })
  const verifyArgs = fake.captures[1]
  assert(verifyArgs.compare === true, 'verify must compare against the previous frame')
  assert(verifyArgs.attach === false, 'verify must not pay for an attachment')
  assert(clicked.change?.changed === true, 'verify must return the change object')
  assert(/CHANGED/.test(clicked.text), 'verify text must state the verdict, got: ' + clicked.text)

  const typed = await tool.execute({ action: 'click', x: 100, y: 200, observe: true })
  assert(fake.captures[2].attach !== false, 'observe must attach the image')
  assert(/CHANGED/.test(typed.text), 'observe text must carry the verdict too')
  return 'grid/mark/dim/compare/verify wired'
})

await step('ui_element: fuzzy find surface', async () => {
  const tool = ctx.collected.find((t) => t.name === 'ui_element')
  const props = tool?.parameters?.properties ?? {}
  assert(props.description, 'ui_element.find is missing the description parameter')
  assert(props.description.type === 'string', 'description must be a string')
  assert(props.limit?.type === 'integer', 'limit must be an integer')
  assert(props.annotate?.type === 'boolean', 'annotate must be a boolean')
  assert(typeof props.nameContains?.description === 'string', 'nameContains must stay documented')
  assert(tool.parameters.required.includes('action'), 'ui_element must still require action')
  return 'description + limit + annotate + nameContains'
})

await step('inject/manifest sanity', async () => {
  assert(name === 'computer-use', 'plugin name must be "computer-use"')
  assert(Array.isArray(inject) && inject.length === 1 && inject[0] === 'tools', 'inject must be ["tools"]')
  assert(typeof name === 'string', 'name must be a named export')
  return `inject=${inject.join(',')}`
})

await step('skills: builtin catalog', async () => {
  const rt = new ComputerRuntime(makeCtx(), normalizeConfig({}))
  try {
    assert(rt.skillStore, 'the default config must build a skill store')
    const excel = rt.skillFor(['EXCEL.EXE'])
    assert(excel && excel.content.includes('名称框'), 'the Excel skill must match EXCEL.EXE and mention 名称框')
    assert(rt.skillFor(['notepad.exe']), 'the notepad skill must match notepad.exe')
    const lines = rt.skillCatalog().split('\n').filter((line) => line.trim().length > 0)
    assert(lines.length >= 8, 'expected at least 8 skills, got ' + lines.length)
    return lines.length + ' skills, excel ' + excel.chars + ' chars'
  } finally {
    await rt.dispose()
  }
})

const backend = join(root, 'src', 'win', 'backend.mjs')
if (!existsSync(backend)) {
  skip('real device: screenshot', 'SKIP no backend yet')
  skip('real device: windows', 'SKIP no backend yet')
} else {
  const cfg = normalizeConfig({})
  const rt = new ComputerRuntime(makeCtx(), cfg)
  await step('real device: screenshot', async () => {
    const value = await rt.capture({})
    assert(value?.view && value.view.width > 0 && value.view.height > 0, 'view.width/height must be > 0')
    assert(value.view.scale > 0, 'view.scale must be > 0')
    assert(value.view.capture && value.view.capture.width > 0, 'view.capture must describe the physical rectangle')
    const image = value.image
    const attached = image && typeof image === 'object' ? 'attachment' : typeof value.savedPath === 'string' ? 'disk' : ''
    assert(attached !== '', 'the capture carried neither an attachment ref nor a saved file path')
    const blocks = createComputerTool(rt, cfg).output.render({ action: 'screenshot' }, value)
    assert(Array.isArray(blocks) && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string', 'render must lead with a text block')
    if (image && typeof image === 'object') assert(blocks.length === 2 && blocks[1].type === 'image', 'render must attach the image block')
    else assert(blocks.length === 1, 'without an attachment store the render carries only text')
    return `${value.view.width}x${value.view.height} scale=${value.view.scale.toFixed(3)} ${attached}`
  })
  await step('real device: windows', async () => {
    const result = await rt.call('windows', {})
    const windows = Array.isArray(result?.windows) ? result.windows : []
    assert(windows.length >= 1, 'expected at least one visible window')
    assert(windows.every((w) => Number.isInteger(w.hwnd) && typeof w.title === 'string'), 'window records must carry hwnd + title')
    const foreground = windows.find((w) => w.foreground)
    return `${windows.length} windows${foreground ? `, foreground "${String(foreground.title).slice(0, 30)}"` : ''}`
  })
  await step('real device: dispose', async () => {
    await rt.dispose()
    assert(rt.host === null && rt.hostState === 'stopped', 'dispose must release the host')
    return 'host stopped'
  })
}

const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0)
for (const row of rows) {
  const ms = `${row.ms.toFixed(0).padStart(5)} ms`
  console.log(`${row.status.padEnd(4)}  ${row.label.padEnd(width)}  ${ms}  ${row.note}`)
}
const passed = rows.filter((row) => row.status === 'PASS').length
const skipped = rows.filter((row) => row.status === 'SKIP').length
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) process.exitCode = 1
