/**
 * The model-facing tool catalog.
 *
 * Four tools, not thirteen: one `computer` tool mirrors the Codex computer-use
 * action surface (see/act/wait), and three companions cover the channels that
 * make desktop control reliable without vision — window management, the UI
 * Automation tree, and the clipboard.
 *
 * Every canonical value is lossless JSON that carries an attachment REFERENCE,
 * never image bytes, so a screenshot costs the session log a few hundred bytes
 * and the bytes themselves live in the harness attachment store.
 * @module dsh-computer-use/tools
 */
import { ToolError, describeChange } from './runtime.js'

/** Canonical value schema: every tool returns one object, documented per action. */
const OUTPUT = { type: 'object', additionalProperties: true }

/** Shared "look again after acting" parameter. */
const OBSERVE = {
  type: 'boolean',
  description: 'Capture a fresh screenshot after the action and return it with the result. Saves one round trip when you know you will need to look again.',
}

/**
 * Build the model-facing blocks for one tool value: the human summary text
 * first, then the durable image reference when the value carries one.
 * @param value - the canonical value returned by `execute`.
 * @returns content blocks for the model.
 */
function renderValue(value) {
  const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
  if (value?.image) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/**
 * One-line description of a window record.
 * @param window - a protocol window record.
 * @returns a compact human line.
 */
function windowLine(window, index) {
  const size = window.bounds ? `${window.bounds.width}x${window.bounds.height} at (${window.bounds.x},${window.bounds.y})` : 'unknown bounds'
  return `${index === undefined ? '-' : index}. ${window.foreground ? '*' : ' '} "${window.title}" [${window.process}] hwnd=${window.hwnd} ${size}${window.minimized ? ' minimized' : ''}`
}

/**
 * Flatten a UI Automation tree into indented lines the model can reason about.
 * Only named or pattern-bearing nodes are emitted; the path of every emitted node
 * is the address `ui_element` accepts back.
 * @param tree - protocol `uia` result.
 * @param maxLines - hard line cap.
 * @returns {string[]} indented outline lines.
 */
function formatUiTree(tree, maxLines = 120) {
  const lines = []
  const walk = (node, level) => {
    if (lines.length >= maxLines) return
    const name = String(node.name ?? '')
    const value = node.value === null || node.value === undefined ? '' : String(node.value)
    const label = name || value || node.automationId || ''
    const interesting = label.length > 0 || (node.patterns ?? []).length > 0
    const nextLevel = interesting ? level + 1 : level
    if (interesting) {
      const bits = [`${'  '.repeat(level)}- ${node.role}`]
      if (label) bits.push(`"${label.slice(0, 140)}"`)
      if (value && value !== name) bits.push(`value="${value.slice(0, 100)}"`)
      const actions = (node.patterns ?? []).filter((p) => p !== 'Scroll' && p !== 'Window')
      if (actions.length > 0) bits.push(`{${actions.join(',')}}`)
      if (node.offscreen) bits.push('(offscreen)')
      bits.push(`path=${node.path}`)
      lines.push(bits.join(' '))
    }
    for (const child of node.children ?? []) walk(child, nextLevel)
  }
  if (tree?.root) walk(tree.root, 0)
  return lines
}

/**
 * The `computer` tool: the Codex action surface.
 * @param runtime - the shared {@link import('./runtime.js').ComputerRuntime}.
 * @param config - normalized configuration.
 * @returns a tool definition.
 */
export function createComputerTool(runtime, config) {
  let description = [
    'Control the real Windows desktop of the human you are talking to: look at the screen, then move the mouse and type.',
    '',
    'Loop: take a screenshot, decide ONE action, act, then screenshot again to verify. Do not fire several blind actions in a row.',
    '',
    'COORDINATES. `x`/`y` are read in the pixel space of the LAST screenshot this tool returned (its width/height are echoed as `view.width`/`view.height`), with (0,0) at the top-left of that image. The plugin maps them onto the physical screen for you, including display scaling. If you have not taken a screenshot yet, coordinate actions fail with NO_REFERENCE_SCREENSHOT: take one first.',
    '',
    'PREFER `ui_element` when the target has a visible name: invoking an element by its accessibility path is exact, survives layout changes, and works even when the model cannot see pixels. Use raw coordinates for canvases, games, and anything unnamed.',
    '',
    'SAFETY. A human is watching and can press Esc at any moment. Every mutating action then fails with STOPPED_BY_HUMAN and stays blocked: stop, say what you were doing and what is on screen, and wait for the human. Call action "resume" only after the human explicitly asks you to continue.',
    '',
    'Actions: screenshot, cursor, move, click, double_click, right_click, middle_click, drag, scroll, type, key, wait, resume, status.',
  ].join('\n')
  const catalog = runtime.skillCatalog()
  if (catalog) description += '\n\nAPP SKILLS (call app_skill with action get and the app name before driving one of these; the skills contain the reliable shortcuts):\n' + catalog

  return {
    name: 'computer',
    description,
    parameters: toParameterJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['screenshot', 'cursor', 'move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'type', 'key', 'wait', 'ocr', 'wait_for', 'resume', 'status'],
        description: 'What to do. `screenshot` is the only read; everything else except `cursor`, `wait`, `status` and `resume` changes the desktop.',
      },
      x: { type: 'integer', description: 'Target x in the last screenshot\'s pixel space (click/move/drag/scroll). Omit to use the current cursor position.' },
      y: { type: 'integer', description: 'Target y in the last screenshot\'s pixel space.' },
      toX: { type: 'integer', description: 'Drag end x, same coordinate space as `x`.' },
      toY: { type: 'integer', description: 'Drag end y, same coordinate space as `y`.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click/drag. Defaults to left.' },
      count: { type: 'integer', description: 'Click count (1-3). `double_click` implies 2.' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'win'] },
        description: 'Modifier keys held during the action (click, drag, scroll, key).',
      },
      text: { type: 'string', description: 'Exact text to type for action `type`. Unicode, including Chinese, is delivered as real keyboard input.' },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key chord for action `key`, pressed in order and released in reverse: ["ctrl","c"], ["enter"], ["alt","tab"], ["f5"].',
      },
      dy: { type: 'integer', description: 'Scroll amount in wheel notches: positive scrolls up/away from the user, negative down. One notch is 120 units; pass e.g. -3 to scroll down three notches.' },
      dx: { type: 'integer', description: 'Horizontal scroll notches (positive = right).' },
      seconds: { type: 'number', description: 'Seconds to wait for action `wait` (0-30).' },
      screen: { type: 'integer', description: 'Screenshot: display index from `view`/ready info. Omit for the primary display.' },
      hwnd: { type: 'integer', description: 'Screenshot: capture just this window instead of the whole display.' },
      region: {
        type: 'object',
        additionalProperties: false,
        description: 'Screenshot: physical-pixel rectangle to capture.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      maxWidth: { type: 'integer', description: 'Screenshot: downscale the capture to at most this pixel width (default from deployment config).' },
      uiSummary: {
        type: 'string',
        enum: ['none', 'summary', 'tree'],
        description: 'Screenshot: how much UI Automation detail to include as text alongside the image. Use "tree" when the image is hard to read or when you need exact element names.',
      },
      grid: {
        type: 'boolean',
        description: 'Screenshot: draw a labelled coordinate grid over the image. Labels are image-space coordinates, so a number read off the grid can be passed straight back to click/move.',
      },
      gridStep: { type: 'integer', description: 'Screenshot: grid spacing in image pixels. Defaults to about a tenth of the image width, rounded to 50.' },
      mark: {
        type: 'object',
        additionalProperties: false,
        description: 'Screenshot: draw a crosshair at this image-space point, e.g. exactly where the next click will land.',
        properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
      },
      dim: {
        type: 'object',
        additionalProperties: false,
        description: 'Screenshot: darken everything outside this image-space rectangle so one region stands out.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      compare: {
        type: 'boolean',
        description: 'Screenshot: report how much of the screen changed since the previous capture of the same target. Screenshot before an action and after it to prove the action did something.',
      },
      verify: {
        type: 'boolean',
        description: 'Actions that change the desktop: take one extra capture after the action and report whether the screen actually changed. Cheaper than observe - no image is attached, only the verdict and the changed region.',
      },
      observe: OBSERVE,
    }),
    output: { schema: OUTPUT, render: (_args, value) => renderValue(value) },
    timeoutMs: 120000,
    presentCall: (args) => ({
      card: 'generic',
      title: `computer: ${args.action ?? 'action'}${args.text ? ` ${JSON.stringify(String(args.text).slice(0, 40))}` : ''}`,
      rawInput: { action: args.action, x: args.x, y: args.y, keys: args.keys },
    }),
    async execute(args) {
      const action = String(args.action)
      switch (action) {
        case 'screenshot': {
          const value = await runtime.capture({
            screen: args.screen,
            hwnd: args.hwnd,
            region: args.region,
            maxWidth: args.maxWidth,
            uiSummary: args.uiSummary,
            grid: args.grid === true,
            gridStep: args.gridStep,
            mark: args.mark ?? null,
            dim: args.dim ?? null,
            compare: args.compare === true,
          })
          return value
        }
        case 'cursor': {
          const cursor = await runtime.call('cursor', {})
          const view = runtime.lastView
          const inImage = view ? { x: Math.round((cursor.x - view.capture.x) * view.scale), y: Math.round((cursor.y - view.capture.y) * view.scale) } : null
          return {
            action,
            ok: true,
            text: `Cursor is at physical (${cursor.x},${cursor.y})${inImage ? `, which is (${inImage.x},${inImage.y}) in the last screenshot` : ''}.`,
            cursor,
          }
        }
        case 'move': {
          const gate = await runtime.beforeMutation('computer', `move the pointer to (${args.x},${args.y})`)
          const target = runtime.toPhysical(args.x, args.y)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would move the pointer to physical (${target.x},${target.y}).` }
          const result = await runtime.call('move', { x: target.x, y: target.y, durationMs: 120 })
          return await afterAction(runtime, args, action, `Moved the pointer to image (${args.x},${args.y}) = physical (${result.x},${result.y}).`, { pointer: result.pointer ?? null })
        }
        case 'click':
        case 'double_click':
        case 'right_click':
        case 'middle_click': {
          const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : (args.button ?? 'left')
          const count = action === 'double_click' ? 2 : Math.min(3, Math.max(1, args.count ?? 1))
          const target = runtime.toPhysical(args.x, args.y)
          const where = target.x === null ? 'the current pointer position' : `physical (${target.x},${target.y})`
          const gate = await runtime.beforeMutation('computer', `${action} ${button} on ${where}`)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would ${action} ${button} on ${where}.` }
          const result = await runtime.call('click', { x: target.x, y: target.y, button, count, modifiers: args.modifiers ?? [] })
          return await afterAction(runtime, args, action, `${action === 'click' ? 'Clicked' : action.replace('_', ' ')} ${button}${count > 1 ? ` x${count}` : ''} at image (${args.x ?? '-'},${args.y ?? '-'}) = physical (${result.x},${result.y}).`, { pointer: result.pointer ?? null })
        }
        case 'drag': {
          const from = runtime.toPhysical(args.x, args.y)
          const to = runtime.toPhysical(args.toX, args.toY)
          if (from.x === null || to.x === null) throw new ToolError('MISSING_COORDINATES', '`drag` needs x/y (start) and toX/toY (end).')
          const gate = await runtime.beforeMutation('computer', `drag from physical (${from.x},${from.y}) to (${to.x},${to.y})`)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would drag from physical (${from.x},${from.y}) to (${to.x},${to.y}).` }
          const result = await runtime.call('drag', { from, to, button: args.button ?? 'left', durationMs: 350, modifiers: args.modifiers ?? [] })
          return await afterAction(runtime, args, action, `Dragged from physical (${result.from.x},${result.from.y}) to (${result.to.x},${result.to.y}).`, { pointer: result.pointer ?? null })
        }
        case 'scroll': {
          const target = runtime.toPhysical(args.x, args.y)
          const dy = Math.trunc(args.dy ?? 0)
          const dx = Math.trunc(args.dx ?? 0)
          if (dy === 0 && dx === 0) throw new ToolError('MISSING_SCROLL_AMOUNT', '`scroll` needs a non-zero `dy` (vertical notches) and/or `dx`.')
          const gate = await runtime.beforeMutation('computer', `scroll dy=${dy} dx=${dx} at physical (${target.x ?? 'cursor'},${target.y ?? 'cursor'})`)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would scroll dy=${dy} dx=${dx}.` }
          const result = await runtime.call('scroll', { x: target.x, y: target.y, dy: dy * 120, dx: dx * 120, modifiers: args.modifiers ?? [] })
          return await afterAction(runtime, args, action, `Scrolled dy=${dy} dx=${dx} notches at physical (${result.x},${result.y}).`, { pointer: result.pointer ?? null })
        }
        case 'type': {
          const text = args.text
          if (typeof text !== 'string' || text.length === 0) throw new ToolError('MISSING_TEXT', '`type` needs `text`.')
          const gate = await runtime.beforeMutation('computer', `type ${JSON.stringify(text.slice(0, 60))}`)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would type ${JSON.stringify(text.slice(0, 60))}.` }
          const result = await runtime.call('type', { text, intervalMs: 0 }, { timeoutMs: Math.max(config.requestTimeoutMs, 5000 + text.length * 40) })
          return await afterAction(runtime, args, action, `Typed ${result.chars ?? text.length} characters${config.dryRun ? ' (dry run)' : ''}.`)
        }
        case 'key': {
          const keys = Array.isArray(args.keys) ? args.keys.filter((k) => typeof k === 'string' && k.length > 0) : []
          if (keys.length === 0) throw new ToolError('MISSING_KEYS', '`key` needs `keys`, e.g. ["ctrl","c"] or ["enter"].')
          const gate = await runtime.beforeMutation('computer', `press ${keys.join('+')}`)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would press ${keys.join('+')}.` }
          await runtime.call('key', { keys })
          return await afterAction(runtime, args, action, `Pressed ${keys.join('+')}.`)
        }
        case 'wait': {
          const seconds = Math.min(30, Math.max(0, Number(args.seconds ?? 1)))
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
          return await afterAction(runtime, args, action, `Waited ${seconds}s.`)
        }
        case 'resume': {
          if (!runtime.tripped) return { action, ok: true, text: 'Nothing to resume: the Esc kill switch is not tripped.' }
          const age = Date.now() - Date.parse(runtime.tripped.at)
          if (age < 5000) {
            throw new ToolError('RESUME_TOO_SOON', `A human pressed Esc ${Math.round(age / 1000)}s ago. Ask them whether to continue and wait for an explicit answer before calling resume.`)
          }
          const previous = runtime.resume()
          runtime.log('info', `kill switch resumed by model after Esc at ${previous?.at}`)
          return { action, ok: true, text: `Kill switch cleared (it had tripped at ${previous?.at}). Mutating actions work again; re-take a screenshot before acting.` }
        }
        case 'ocr': {
          const seen = await runtime.recognize({ lang: args.lang, maxLines: args.maxLines, hwnd: args.hwnd, region: args.region })
          const listed = seen.lines.slice(0, 80).map((line) => '- "' + line.text + '" at (' + line.bounds.x + ',' + line.bounds.y + ') ' + line.bounds.width + 'x' + line.bounds.height)
          const text = ['OCR ' + seen.lang + ' (' + seen.lines.length + ' lines, ' + seen.elapsedMs + 'ms):'].concat(listed)
          if (seen.lines.length > 80) text.push('[' + (seen.lines.length - 80) + ' more lines omitted]')
          if (seen.lines.length === 0) text.push('No text was recognized in this region; try a tighter region or a different lang.')
          return { action, ok: true, text: text.join('\n'), lines: seen.lines, lang: seen.lang, engine: seen.engine }
        }
        case 'wait_for': {
          const waited = await runtime.waitFor({ kind: args.waitKind, timeoutMs: args.timeoutMs, titleMatch: args.titleMatch, name: args.name, text: args.text, hwnd: args.hwnd, lang: args.lang })
          if (waited.ok !== true) throw new ToolError(waited.error?.code ?? 'WAIT_TIMEOUT', (waited.error?.message ?? 'The wait did not match') + ' (kind ' + waited.kind + ', waited ' + waited.waitedMs + 'ms). Take a screenshot to see the current state.')
          const what = waited.window ? ' window "' + waited.window.title + '"' : waited.element ? ' element ' + waited.element.role + ' "' + waited.element.name + '" path=' + waited.element.path : waited.line ? ' text "' + waited.line.text + '"' : ''
          return { action, ok: true, text: 'Waited ' + waited.waitedMs + 'ms for ' + waited.kind + what + ' (' + waited.frames + ' checks).', wait: waited }
        }        case 'status': {
          const guard = await runtime.guardStatus()
          return {
            action,
            ok: true,
            text: [
              `host: ${runtime.hostState}`,
              `overlay: ${runtime.overlayArmed ? 'visible' : 'hidden'}${runtime.overlayError ? ` (error: ${runtime.overlayError})` : ''}`,
              `esc kill switch: ${runtime.tripped ? `TRIPPED at ${runtime.tripped.at}` : 'clear'}${guard.reason ? ` (${guard.reason})` : ''}`,
              `dry run: ${runtime.config.dryRun ? 'yes' : 'no'}`,
              `mutating actions so far: ${runtime.mutations}`,
              `coordinate space: ${runtime.config.coordinates}${runtime.lastView ? `, last screenshot ${runtime.lastView.width}x${runtime.lastView.height} (scale ${runtime.lastView.scale})` : ', no screenshot yet'}`,
            ].join('\n'),
          }
        }
        default:
          throw new ToolError('UNKNOWN_ACTION', `Unknown action "${action}".`)
      }
    },
  }
}

/**
 * Compose the value for one completed mutating action, optionally with a fresh
 * screenshot so the model can verify the effect in the same round trip.
 * @param runtime - shared runtime.
 * @param args - tool arguments (for `observe`).
 * @param action - action name.
 * @param text - what happened, in one line.
 * @returns the canonical value.
 */
async function afterAction(runtime, args, action, text, extra = null) {
  const receipt = extra && typeof extra === 'object' ? { ...extra } : {}
  const delay = runtime.config.actionDelayMs ?? 0
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

  // Compare against the SAME target the model was last looking at: a window
  // capture diffed against a full-screen capture (or vice versa) is meaningless
  // and would always answer "no previous frame".
  const target = runtime.lastView?.window?.hwnd ?? null

  // observe: the model wants to look at the result, so pay for the pixels.
  if (config_wantsObserve(args)) {
    const shot = await runtime.capture({ hwnd: target, compare: true })
    const verdict = describeChange(shot.change).join('\n')
    return { ...receipt, ...shot, action, ok: true, text: `${text}\n${verdict}\nFresh screenshot attached.` }
  }

  // verify: the model only wants the verdict, so skip the attachment, the UI
  // outline and the image encoding that make an observe round trip expensive.
  if (config_wantsVerify(args)) {
    const shot = await runtime.capture({ hwnd: target, compare: true, attach: false, uiSummary: 'none' })
    const verdict = describeChange(shot.change).join('\n')
    return { ...receipt, action, ok: true, change: shot.change, view: shot.view, cursor: shot.cursor, text: `${text}\n${verdict}` }
  }

  return { ...receipt, action, ok: true, text }
}

/**
 * Whether this call asked for a silent post-action verification.
 * @param args - tool arguments.
 * @returns true when `verify` is set and `observe` is not.
 */
/**
 * Whether this call asked for a fresh screenshot after the action.
 * @param args - tool arguments.
 * @returns true when observe is set.
 */
function config_wantsObserve(args) {
  return args?.observe === true
}

function config_wantsVerify(args) {
  return args?.verify === true && args?.observe !== true
}

/* ========================================================================== *
 * Companion tools
 *
 * The three factories below share `computer`'s value contract: one canonical
 * object per call, a human summary in `text`, the attachment REFERENCE in
 * `image`, and a fresh capture appended when the caller passes `observe: true`.
 * They reuse the private helpers above (`renderValue`, `windowLine`,
 * `formatUiTree`, `OUTPUT`, `OBSERVE`) so the four tools cannot drift apart.
 * ========================================================================== */

import { spawn } from 'node:child_process'
import { basename } from 'node:path'

/** Render a protocol rectangle as `(x,y,w,h)` for model-facing text. */
function boundsText(bounds) {
  if (!bounds || typeof bounds !== 'object') return 'unknown bounds'
  return `(${bounds.x},${bounds.y},${bounds.width},${bounds.height})`
}

/** One window as a label usable in an action description or an ambiguity list. */
function windowLabel(window) {
  return `"${window?.title ?? ''}" [${window?.process ?? '?'}] hwnd=${window?.hwnd ?? '?'}`
}

/**
 * Visible, titled top-level windows from the host.
 * @param runtime - shared runtime.
 * @param filter - optional case-insensitive title/process substring.
 * @returns {Promise<object[]>} protocol window records (foreground first).
 */
async function listWindows(runtime, filter) {
  const result = await runtime.call('windows', { filter: typeof filter === 'string' ? filter : '' })
  return Array.isArray(result?.windows) ? result.windows : []
}

/**
 * Pick the windows a call refers to: an exact `hwnd` wins, otherwise a
 * case-insensitive substring over title and process name.
 * @param windows - candidate windows.
 * @param args - tool arguments.
 * @returns {object[]} matching windows (possibly zero, possibly many).
 */
function matchWindows(windows, args) {
  if (Number.isInteger(args?.hwnd)) return windows.filter((w) => Number(w.hwnd) === args.hwnd)
  const needle = typeof args?.titleMatch === 'string' ? args.titleMatch.trim().toLowerCase() : ''
  if (!needle) return []
  return windows.filter((w) => `${w.title ?? ''} ${w.process ?? ''}`.toLowerCase().includes(needle))
}

/**
 * Resolve exactly one window for a mutating action, or fail with a code the
 * model can act on. Never guesses between several candidates: closing the wrong
 * window is unrecoverable.
 * @param runtime - shared runtime.
 * @param args - tool arguments (`hwnd`, `titleMatch`).
 * @returns {Promise<object>} the single matching window record.
 */
async function resolveWindow(runtime, args) {
  if (!Number.isInteger(args?.hwnd) && !(typeof args?.titleMatch === 'string' && args.titleMatch.trim())) {
    throw new ToolError(
      'MISSING_WINDOW_TARGET',
      'This action needs `hwnd` or `titleMatch`. Call app_window with action "list" first and pass the hwnd of the window you mean.',
    )
  }
  const windows = await listWindows(runtime, '')
  const candidates = matchWindows(windows, args)
  if (candidates.length === 0) {
    const what = Number.isInteger(args?.hwnd) ? `hwnd=${args.hwnd}` : `title matching "${args.titleMatch}"`
    throw new ToolError(
      'WINDOW_NOT_FOUND',
      `No visible top-level window matched ${what}. Call app_window with action "list" to see what is open; the window may have been closed or may be hidden.`,
    )
  }
  if (candidates.length > 1) {
    const listed = candidates.slice(0, 10).map((w) => windowLabel(w)).join('; ')
    throw new ToolError(
      'AMBIGUOUS_WINDOW',
      `"${args.titleMatch}" matches ${candidates.length} windows: ${listed}${candidates.length > 10 ? '; ...' : ''}. Retry with the exact hwnd of the one you mean.`,
    )
  }
  return candidates[0]
}

/**
 * Append a fresh screenshot to an already-built value ("look again" tail).
 * @param runtime - shared runtime.
 * @param action - the action that just completed.
 * @param value - the canonical value built so far.
 * @returns {Promise<object>} the value plus `image`/`view` and a fresh capture.
 */
async function attachFresh(runtime, action, value) {
  const shot = await runtime.capture({})
  return { ...value, ...shot, action, ok: true, text: `${value.text}\nFresh screenshot attached.` }
}

/**
 * Clip an outline to a hard line/character budget.
 * @param lines - outline lines.
 * @param maxLines - maximum emitted lines.
 * @param maxChars - maximum emitted characters.
 * @returns {{text:string,cut:boolean}} the clipped text and whether it was cut.
 */
function clipOutline(lines, maxLines, maxChars) {
  const out = []
  let chars = 0
  let cut = false
  for (const line of lines) {
    if (out.length >= maxLines || chars + line.length + 1 > maxChars) {
      cut = true
      break
    }
    out.push(line)
    chars += line.length + 1
  }
  if (cut) out.push('[outline truncated ...]')
  return { text: out.join('\n'), cut }
}

/**
 * Best-effort title of one window, used to make action labels (and therefore
 * the blocklist and the approval prompt) name a real target.
 * @param runtime - shared runtime.
 * @param hwnd - window handle or null.
 * @returns {Promise<string>} the title, or an empty string.
 */
async function windowTitleOf(runtime, hwnd) {
  if (!Number.isInteger(hwnd)) return ''
  try {
    const windows = await listWindows(runtime, '')
    return String(windows.find((w) => Number(w.hwnd) === hwnd)?.title ?? '')
  } catch {
    return ''
  }
}

/**
 * The `app_window` tool: find, focus, arrange, close and start real windows.
 * @param runtime - the shared {@link import('./runtime.js').ComputerRuntime}.
 * @param config - normalized configuration.
 * @returns a tool definition.
 */
export function createAppWindowTool(runtime, config) {
  const description = [
    'Manage real Windows application windows: see what is open, bring one to the front, resize or dismiss it, or start a program.',
    '',
    'Start with action "list": it returns every visible top-level window with its hwnd, title, process, bounds and whether it is foreground. Then act on one window by `hwnd`, or by `titleMatch` (case-insensitive substring of the title or process name) when you do not have the handle. A title that matches several windows fails with AMBIGUOUS_WINDOW and lists the candidates, so you never close the wrong thing by accident.',
    '',
    '`focus` brings a window to the foreground; confirm with `observe: true`, or follow up with `computer` action "screenshot", because a window can refuse the foreground lock.',
    '`launch` starts an executable directly (not through a shell) and waits for its window; if no window appears it says so instead of guessing.',
    '`close` asks the window to close (unsaved work may show a dialog) and can be disabled by the deployment, in which case it fails with CLOSE_DISABLED.',
    '',
    'Read-only: list. Mutating: focus, launch, close, minimize, maximize, restore (these pass the Esc kill switch and the deployment blocklist).',
    '',
    'To click or type inside a window, prefer `ui_element`; use `computer` with coordinates when the control has no name.',
  ].join('\n')

  return {
    name: 'app_window',
    description,
    parameters: toParameterJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'focus', 'launch', 'close', 'minimize', 'maximize', 'restore'],
        description: 'What to do with the window. `list` is a read; everything else changes the desktop.',
      },
      hwnd: { type: 'integer', description: 'Window handle from action "list". Preferred over `titleMatch` when known.' },
      titleMatch: { type: 'string', description: 'Case-insensitive substring of the window title or process name, used when `hwnd` is absent. Must identify exactly one window.' },
      filter: { type: 'string', description: 'action "list" only: case-insensitive substring to narrow the listing (e.g. "chrome", "记事本").' },
      command: { type: 'string', description: 'action "launch" only: executable name or full path, e.g. "notepad.exe" or "C:\\\\Windows\\\\System32\\\\mspaint.exe".' },
      args: { type: 'array', items: { type: 'string' }, description: 'action "launch" only: command-line arguments, one array entry per argument (no shell quoting needed).' },
      observe: OBSERVE,
    }),
    output: { schema: OUTPUT, render: (_args, value) => renderValue(value) },
    timeoutMs: 120000,
    presentCall: (args) => {
      const target = args.titleMatch ?? (args.hwnd != null ? `hwnd=${args.hwnd}` : args.command)
      return {
        card: 'generic',
        title: `app_window: ${args.action ?? 'action'}${target ? ` ${JSON.stringify(String(target).slice(0, 60))}` : ''}`,
        rawInput: { action: args.action, hwnd: args.hwnd, titleMatch: args.titleMatch, command: args.command },
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      switch (action) {
        case 'list': {
          const windows = await listWindows(runtime, args.filter)
          const scope = typeof args.filter === 'string' && args.filter.trim() ? ` matching "${args.filter.trim()}"` : ''
          const head = `${windows.length} visible window${windows.length === 1 ? '' : 's'}${scope}. The foreground window is marked with *.`
          const body = windows.map((w, i) => windowLine(w, i + 1)).join('\n')
          const value = {
            action,
            ok: true,
            text: `${head}\n${body || '(no visible titled windows)'}\nhost: ${runtime.hostState}`,
            count: windows.length,
            windows,
            hostState: runtime.hostState,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }
        case 'focus': {
          const hasTarget = Number.isInteger(args.hwnd) || (typeof args.titleMatch === 'string' && args.titleMatch.trim().length > 0)
          const target = hasTarget ? await resolveWindow(runtime, args) : null
          const label = 'focus window ' + (target ? windowLabel(target) : '(the foreground window)')
          const gate = await runtime.beforeMutation('app_window', label, exec)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: '[dry run] Would ' + label + '.', window: target }
          const result = await runtime.call('focus', {
            hwnd: target ? target.hwnd : null,
            titleMatch: target ? null : typeof args.titleMatch === 'string' ? args.titleMatch : null,
          })
          const window = result?.window ?? result
          const value = {
            action,
            ok: true,
            text: `Focused ${windowLabel(window)} at ${boundsText(window?.bounds)}. Confirm with observe: true or a computer screenshot before acting inside it.`,
            window,
            hwnd: window?.hwnd ?? null,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }
        case 'close':
        case 'minimize':
        case 'maximize':
        case 'restore': {
          if (action === 'close' && config.allowCloseWindow === false) {
            throw new ToolError(
              'CLOSE_DISABLED',
              'Closing windows is disabled by this deployment. Use action "minimize" instead, or ask the human to close it themselves.',
            )
          }
          const window = await resolveWindow(runtime, args)
          const label = `${action} window ${windowLabel(window)}`
          const gate = await runtime.beforeMutation('app_window', label, exec)
          if (gate.dryRun) {
            return { action, ok: true, dryRun: true, text: `[dry run] Would ${label}.`, window }
          }
          const result = await runtime.call('window', { op: action, hwnd: window.hwnd })
          const done = { close: 'Closed', minimize: 'Minimized', maximize: 'Maximized', restore: 'Restored' }[action]
          const value = {
            action,
            ok: true,
            text: `${done} ${windowLabel(window)}${result?.bounds ? ` bounds=${boundsText(result.bounds)}` : ''}.`,
            window,
            hwnd: window.hwnd,
            result: result ?? null,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }
        case 'launch': {
          if (config.allowLaunch === false) {
            throw new ToolError(
              'LAUNCH_DISABLED',
              'Starting programs is disabled by this deployment. Ask the human to open the application, then use action "list" to find it.',
            )
          }
          const command = typeof args.command === 'string' ? args.command.trim() : ''
          if (!command) throw new ToolError('MISSING_COMMAND', '`launch` needs `command`, e.g. "notepad.exe" or a full path to the executable.')
          const argv = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string') : []
          const processName = basename(command).replace(/\.(exe|com|bat|cmd)$/i, '') || command
          const label = `launch ${command}${argv.length > 0 ? ` ${argv.join(' ')}` : ''}`
          const gate = await runtime.beforeMutation('app_window', label, exec)
          if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would ${label}.` }

          const before = new Set((await listWindows(runtime, '')).map((w) => Number(w.hwnd)))
          let child = null
          let spawnError = null
          try {
            child = spawn(command, argv, { detached: true, stdio: 'ignore' })
            child.once('error', (cause) => {
              spawnError = cause
            })
            child.unref()
          } catch (cause) {
            throw new ToolError('LAUNCH_FAILED', `Could not start ${JSON.stringify(command)}: ${cause?.message ?? cause}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 600))
          if (spawnError) {
            throw new ToolError('LAUNCH_FAILED', `Could not start ${JSON.stringify(command)}: ${spawnError?.message ?? spawnError}. Check the executable name or path and try again.`)
          }
          const windows = await listWindows(runtime, processName)
          const fresh = windows.filter((w) => !before.has(Number(w.hwnd)))
          const target = fresh[0] ?? windows[0] ?? null
          let text
          if (fresh.length > 0) {
            text = `Started ${JSON.stringify(command)}${child?.pid ? ` (pid ${child.pid})` : ''} and its window is up: ${windowLine(fresh[0])} at ${boundsText(fresh[0]?.bounds)}.`
          } else if (windows.length > 0) {
            text = `Started ${JSON.stringify(command)}${child?.pid ? ` (pid ${child.pid})` : ''}; it reused the existing window ${windowLabel(windows[0])}.`
          } else {
            text = `Started ${JSON.stringify(command)}${child?.pid ? ` (pid ${child.pid})` : ''}, but no window appeared within 600ms. It may still be starting: wait a moment, then call action "list" with filter "${processName}", or take a computer screenshot.`
          }
          const value = {
            action,
            ok: true,
            text,
            command,
            pid: child?.pid ?? null,
            process: processName,
            window: target,
            windows: fresh.length > 0 ? fresh : windows,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }
        default:
          throw new ToolError('UNKNOWN_ACTION', `Unknown action "${action}". Use one of: list, focus, launch, close, minimize, maximize, restore.`)
      }
    },
  }
}

/**
 * The `ui_element` tool: read the UI Automation tree and act on one node by path.
 * @param runtime - the shared {@link import('./runtime.js').ComputerRuntime}.
 * @param config - normalized configuration.
 * @returns a tool definition.
 */
export function createUiElementTool(runtime, config) {
  const description = [
    'Read and operate individual controls through Windows UI Automation. This is exact and layout-independent, so it is more reliable than clicking blind coordinates: the control is addressed by its accessibility path, not by pixels.',
    '',
    'Workflow: action "tree" returns the outline of a window\'s controls, each line ending in `path=0/2/1`. Then act on that path with invoke (press a button), set_value (fill a text box), focus, expand, collapse, or select.',
    '',
    'When you only know roughly what you are looking for, use action "find" with `nameContains` (case-insensitive substring of name, value or automationId) and/or `role` (e.g. "Button", "Edit", "ListItem"): it returns up to 20 matching paths to pass to the acting actions.',
    '',
    'Paths are only valid while the window keeps that layout: if the window was resized, navigated or repopulated, or the action fails with a stale path, take action "tree" again before retrying.',
    '',
    'Actions tree and find are reads; invoke, set_value, focus, expand, collapse and select are mutating and pass the Esc kill switch and the deployment blocklist.',
  ].join('\n')

  const ACTIONS = {
    invoke: 'invoke',
    set_value: 'setValue',
    focus: 'focus',
    expand: 'expand',
    collapse: 'collapse',
    select: 'select',
  }
  const PAST = {
    invoke: 'Invoked',
    set_value: 'Set the value of',
    focus: 'Focused',
    expand: 'Expanded',
    collapse: 'Collapsed',
    select: 'Selected',
  }

  return {
    name: 'ui_element',
    description,
    parameters: toParameterJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['tree', 'find', 'invoke', 'set_value', 'focus', 'expand', 'collapse', 'select'],
        description: 'What to do. `tree` and `find` are reads; the rest operate on the element at `path`.',
      },
      hwnd: { type: 'integer', description: 'Target window handle from app_window action "list". Omit for the foreground window.' },
      path: { type: 'string', description: 'Element path from `tree`/`find`, e.g. "0/2/1". Required by every acting action.' },
      nameContains: { type: 'string', description: 'action "find": case-insensitive substring matched against each control\'s name, value and automationId.' },
      role: { type: 'string', description: 'action "find": control role filter, e.g. "Button", "Edit", "MenuItem", "ListItem".' },
      value: { type: 'string', description: 'action "set_value": the exact text to put into the control.' },
      maxDepth: { type: 'integer', description: 'How deep to walk the control tree (default 8). Lower it when the tree is huge.' },
      maxNodes: { type: 'integer', description: 'Maximum controls to walk before truncating (default 1200).' },
      observe: OBSERVE,
    }),
    output: { schema: OUTPUT, render: (_args, value) => renderValue(value) },
    timeoutMs: 120000,
    presentCall: (args) => {
      const target = args.path ?? args.nameContains ?? (args.hwnd != null ? `hwnd=${args.hwnd}` : undefined)
      return {
        card: 'generic',
        title: `ui_element: ${args.action ?? 'action'}${target ? ` ${JSON.stringify(String(target).slice(0, 60))}` : ''}`,
        rawInput: { action: args.action, hwnd: args.hwnd, path: args.path, nameContains: args.nameContains },
      }
    },
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const hwnd = Number.isInteger(args.hwnd) ? args.hwnd : null
      const maxDepth = Number.isInteger(args.maxDepth) ? Math.min(20, Math.max(1, args.maxDepth)) : 8
      const maxNodes = Number.isInteger(args.maxNodes) ? Math.min(5000, Math.max(1, args.maxNodes)) : 1200

      if (action === 'tree' || action === 'find') {
        const tree = await runtime.call('uia', {
          hwnd,
          depth: maxDepth,
          maxDepth,
          maxNodes,
          includeOffscreen: false,
        })
        const nodes = Number(tree?.nodes ?? 0)
        const hostTruncated = tree?.truncated === true
        if (action === 'tree') {
          const clip = clipOutline(formatUiTree(tree, 400), 200, 12000)
          const truncated = hostTruncated || clip.cut
          const value = {
            action,
            ok: true,
            text: `${clip.text}\nnodes=${nodes} truncated=${truncated}`,
            hwnd: tree?.hwnd ?? hwnd,
            nodes,
            truncated,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }

        const needle = typeof args.nameContains === 'string' ? args.nameContains.trim().toLowerCase() : ''
        const roleNeedle = typeof args.role === 'string' ? args.role.trim().toLowerCase() : ''
        if (!needle && !roleNeedle) {
          throw new ToolError(
            'MISSING_FILTER',
            'action "find" needs `nameContains` and/or `role`. Pass the visible label of the control (e.g. "保存") or its role (e.g. "Button"); use action "tree" if you have neither.',
          )
        }
        const matches = []
        const walk = (node) => {
          if (!node || matches.length >= 20) return
          const name = String(node.name ?? '')
          const value = node.value === null || node.value === undefined ? '' : String(node.value)
          const automationId = String(node.automationId ?? '')
          const roleText = String(node.role ?? '')
          const haystack = `${name}\n${value}\n${automationId}`.toLowerCase()
          const okName = !needle || haystack.includes(needle)
          const okRole = !roleNeedle || roleText.toLowerCase().includes(roleNeedle)
          if (okName && okRole) {
            matches.push({
              path: node.path,
              role: roleText,
              name,
              value: value || null,
              automationId: automationId || null,
              bounds: node.bounds ?? null,
              enabled: node.enabled !== false,
              offscreen: node.offscreen === true,
            })
          }
          for (const child of node.children ?? []) walk(child)
        }
        walk(tree?.root)
        if (matches.length === 0) {
          const value = {
            action,
            ok: true,
            found: 0,
            matches: [],
            text: `no element matched ${needle ? `nameContains=${JSON.stringify(args.nameContains)}` : ''}${needle && roleNeedle ? ' and ' : ''}${roleNeedle ? `role=${JSON.stringify(args.role)}` : ''} under ${hwnd === null ? 'the foreground window' : `hwnd=${hwnd}`} (${nodes} controls walked). Use ui_element with action "tree" to read the actual control names, or computer action "screenshot" with uiSummary "tree" to look at them visually.`,
          }
          return args.observe === true ? await attachFresh(runtime, action, value) : value
        }
        const listed = matches.map((m) => `${m.role} "${m.name || m.automationId || m.value || ''}" path=${m.path} bounds=${boundsText(m.bounds)}`)
        const value = {
          action,
          ok: true,
          found: matches.length,
          matches,
          text: `${matches.length} element${matches.length === 1 ? '' : 's'} matched under ${hwnd === null ? 'the foreground window' : `hwnd=${hwnd}`}:\n${listed.join('\n')}\nAct on one with its path, e.g. action "invoke" path="${matches[0].path}".`,
        }
        return args.observe === true ? await attachFresh(runtime, action, value) : value
      }

      const protocolAction = ACTIONS[action]
      if (!protocolAction) {
        throw new ToolError('UNKNOWN_ACTION', `Unknown action "${action}". Use one of: tree, find, invoke, set_value, focus, expand, collapse, select.`)
      }
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      if (!path) {
        throw new ToolError('MISSING_PATH', `action "${action}" needs \`path\`, e.g. "0/2/1" from action "tree" or "find".`)
      }
      if (action === 'set_value' && typeof args.value !== 'string') {
        throw new ToolError('MISSING_VALUE', 'action "set_value" needs `value`, the exact text to put into the control.')
      }
      const title = await windowTitleOf(runtime, hwnd)
      const where = title ? ` in window "${title}"` : hwnd === null ? ' in the foreground window' : ` in hwnd=${hwnd}`
      const label = `${action} element path=${path}${where}`
      const gate = await runtime.beforeMutation('ui_element', label, exec)
      if (gate.dryRun) return { action, ok: true, dryRun: true, text: `[dry run] Would ${label}.`, path }
      const result = await runtime.call('uiaAct', {
        hwnd,
        path,
        action: protocolAction,
        value: action === 'set_value' ? args.value : null,
      })
      const value = {
        action,
        ok: true,
        text: `${PAST[action]} path=${path}${where}${result?.bounds ? ` bounds=${boundsText(result.bounds)}` : ''}.`,
        path,
        hwnd,
        result: result ?? null,
      }
      return args.observe === true ? await attachFresh(runtime, action, value) : value
    },
  }
}

/**
 * The clipboard tool: read what the human just copied, or hand them text.
 * @param runtime - the shared {@link import('./runtime.js').ComputerRuntime}.
 * @param config - normalized configuration.
 * @returns a tool definition.
 */
export function createClipboardTool(runtime, config) {
  const description = [
    'Read or replace the text on the local clipboard.',
    '',
    'Use action "get" to pick up what the human just copied (a URL, an error message, a table): it is usually faster and exact compared with reading the screen. The full clipboard text is always in the value field clipboard; the summary text is shortened when it is very long.',
    '',
    'Use action "set" to put text there before pasting it with `computer` action "key" (ctrl+v). This OVERWRITES the human\'s clipboard, so it is a mutating action and passes the Esc kill switch.',
    '',
    'Plain text only. Images and files on the clipboard are not read or written.',
  ].join('\n')

  return {
    name: 'clipboard',
    description,
    parameters: toParameterJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['get', 'set'],
        description: '`get` reads the clipboard (a read); `set` overwrites it with `text` (mutating).',
      },
      text: { type: 'string', description: 'action "set": the exact text to place on the clipboard.' },
    }),
    output: { schema: OUTPUT, render: (_args, value) => renderValue(value) },
    timeoutMs: 60000,
    presentCall: (args) => ({
      card: 'generic',
      title: `clipboard: ${args.action ?? 'action'}${args.action === 'set' && args.text ? ` ${JSON.stringify(String(args.text).slice(0, 40))}` : ''}`,
      rawInput: { action: args.action, length: typeof args.text === 'string' ? args.text.length : undefined },
    }),
    async execute(args, exec) {
      const action = String(args.action ?? '')
      if (action === 'get') {
        const result = await runtime.call('clipboard', { op: 'get' })
        const text = String(result?.text ?? '')
        const length = text.length
        if (length === 0) {
          return { action, ok: true, length: 0, clipboard: '', text: 'The clipboard is empty (no text on it).' }
        }
        const preview = length > 8000
          ? `${text.slice(0, 4000)}\n[...truncated: ${length} characters on the clipboard, first 4000 shown here; the full text is in the clipboard field of this result]`
          : text
        return {
          action,
          ok: true,
          length,
          clipboard: text,
          text: `Clipboard holds ${length} character${length === 1 ? '' : 's'}:\n${preview}`,
        }
      }
      if (action === 'set') {
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.length === 0) {
          throw new ToolError('MISSING_TEXT', 'action "set" needs `text`; the clipboard is left untouched when it is missing.')
        }
        const label = `overwrite the clipboard with ${text.length} character${text.length === 1 ? '' : 's'}`
        const gate = await runtime.beforeMutation('clipboard', label, exec)
        if (gate.dryRun) return { action, ok: true, dryRun: true, length: text.length, text: `[dry run] Would ${label}.` }
        await runtime.call('clipboard', { op: 'set', text })
        return {
          action,
          ok: true,
          length: text.length,
          text: `Copied ${text.length} character${text.length === 1 ? '' : 's'} to the clipboard. Paste it with computer action "key" and keys ["ctrl","v"].`,
        }
      }
      throw new ToolError('UNKNOWN_ACTION', `Unknown action "${action}". Use "get" or "set".`)
    },
  }
}

/**
 * Compile a parameter property-map into the JSON Schema the host registers.
 *
 * Tool factories author parameters as a property map, because that reads well
 * next to the code that consumes the arguments, while the host registers a
 * compiled JSON Schema. This converts one into the other: a required flag on a
 * property is hoisted into the parent required array and removed from the
 * property node; object children are compiled recursively and always end up with
 * additionalProperties, which the host validator insists on; array items are
 * compiled the same way. Every other field passes through verbatim, and the
 * input object is never mutated.
 *
 * The root carries no additionalProperties on purpose: the host compiler does
 * not add one either.
 * @param specMap - the property map authored by a tool factory.
 * @returns a compiled JSON Schema object for one tool parameters.
 */
export function toParameterJsonSchema(specMap) {
  const { properties, required } = compileProperties(specMap)
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Compile one level of a property map.
 * @param specMap - the property map to compile.
 * @returns the compiled properties plus the hoisted required names.
 */
function compileProperties(specMap) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(specMap ?? {})) {
    properties[key] = compileProperty(spec)
    if (spec && typeof spec === 'object' && spec.required === true) required.push(key)
  }
  return { properties, required }
}

/**
 * Compile a single property node without mutating the authored spec.
 * @param spec - one entry of a property map.
 * @returns a JSON Schema node.
 */
function compileProperty(spec) {
  if (!spec || typeof spec !== 'object') return spec
  const node = { ...spec }
  if (node.required === true) delete node.required
  if (node.type === 'object') {
    if (node.properties && typeof node.properties === 'object') {
      const nested = compileProperties(node.properties)
      node.properties = nested.properties
      const own = Array.isArray(node.required) ? node.required : []
      if (nested.required.length > 0) node.required = [...own, ...nested.required]
      else if (own.length === 0) delete node.required
    }
    if (typeof node.additionalProperties !== 'boolean') node.additionalProperties = false
  }
  if (node.type === 'array' && node.items && typeof node.items === 'object') node.items = compileProperty(node.items)
  return node
}

/* --------------------------------------------------------------- app_skill */

/**
 * The app_skill tool: per-application operating recipes from the skill library.
 * @param runtime - the shared ComputerRuntime (it owns the SkillStore).
 * @param config - normalized configuration.
 * @returns a tool definition.
 */
export function createAppSkillTool(runtime, config) {
  const description = [
    'Look up the reliable operating recipe for a desktop application before driving it.',
    '',
    'Some apps are easy to drive with their own shortcuts and much easier to break with blind clicking: Excel has a name box, Explorer has the address bar, a terminal has completion. A skill is a short markdown recipe listing the hotkeys, exact menu paths and pitfalls of one app.',
    '',
    'Action list shows which apps have a skill. Action get returns one in full: pass an app or exe name such as Excel or EXCEL.EXE, or omit app to use the window that is currently in front.',
    '',
    'When a computer screenshot comes back with a line like App skill available for Excel: ..., read that skill with app_skill BEFORE clicking or typing.',
    '',
    'This tool reads local markdown files, so list and get are always safe. It can also WRITE: action save creates or (with overwrite) replaces one user skill, append adds a line or two to an existing recipe, and remove deletes a user skill. Built-in skills cannot be removed, only overridden by a user skill with the same app. Write only what actually saves a wrong turn next time (the exact hotkey, menu path or pitfall), never a whole manual: skills are capped at 4000 characters. Writing is a mutating action, so it passes the same safety gate as a click. Pass refresh: true after a human edits a skill file by hand.',
  ].join('\n')

  return {
    name: 'app_skill',
    description,
    parameters: toParameterJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get', 'save', 'append', 'remove'],
        description: 'list shows the loaded skills; get returns one in full; save/append/remove edit the writable user layer (mutating).',
      },
      app: { type: 'string', description: 'App name or exe name, case-insensitive, e.g. Excel or EXCEL.EXE. Omit for get to use the foreground window of the last screenshot.' },
      content: { type: 'string', description: 'save/append: markdown body. Keep it short - the hotkeys, menu paths and pitfalls that stop the next attempt from going wrong.' },
      summary: { type: 'string', description: 'save: one short line shown in the skill catalog.' },
      match: { type: 'array', items: { type: 'string' }, description: 'save: process or exe names that should match this skill, e.g. EXCEL.EXE.' },
      overwrite: { type: 'boolean', description: 'save: replace an existing user skill with the same app id.' },
      refresh: { type: 'boolean', description: 'Re-read the skill directories first, to pick up a skill file that was just edited.' },
    }),
    output: { schema: OUTPUT, render: (_args, value) => renderValue(value) },
    timeoutMs: 60000,
    presentCall: (args) => ({
      card: 'generic',
      title: 'app_skill: ' + String(args.action ?? 'action') + (args.app ? ' ' + String(args.app).slice(0, 40) : ''),
      rawInput: { action: args.action, app: args.app, refresh: args.refresh },
    }),
    async execute(args, exec) {
      const action = String(args.action ?? '')
      const store = runtime.skillStore
      if (args.refresh === true && store) {
        try {
          store.reload()
        } catch (cause) {
          throw new ToolError('SKILLS_RELOAD_FAILED', 'Could not re-read the skill directories: ' + String(cause?.message ?? cause))
        }
      }
      const skills = store ? store.list() : []

      if (action === 'list') {
        const catalog = runtime.skillCatalog()
        if (!catalog || skills.length === 0) {
          return {
            action,
            ok: true,
            count: 0,
            skills: [],
            text: 'no app skills loaded. No application has a skill file in this deployment, so drive apps with computer and ui_element directly. Deployment note: `skills: false` disables the library, and this tool then always answers that skills are off; add a markdown file under the user skills directory to teach the agent a new app.',
          }
        }
        const dirs = 'builtin: ' + String(store.builtinDir) + (store.userDir ? ', user: ' + String(store.userDir) : '')
        return {
          action,
          ok: true,
          count: skills.length,
          skills: skills.map((skill) => skill.app),
          text: catalog + '\n' + skills.length + ' skill' + (skills.length === 1 ? '' : 's') + ' from ' + dirs,
        }
      }

      if (action === 'save' || action === 'append' || action === 'remove') {
        const appName = typeof args.app === 'string' ? args.app.trim() : ''
        if (appName.length === 0) throw new ToolError('SKILL_APP_REQUIRED', 'a skill needs an `app` name, for example Excel or EXCEL.EXE')
        const label = 'write the ' + appName + ' skill (' + action + ')'
        const gate = await runtime.beforeMutation('app_skill', label, exec)
        if (gate.dryRun) return { action, ok: true, dryRun: true, text: '[dry run] Would ' + label + '.' }
        if (!store) throw new ToolError('SKILLS_READ_ONLY', 'App skills are disabled in this deployment (skills: false), so nothing was written. Re-enable skills to teach the agent a recipe.')
        try {
          if (action === 'save') {
            const saved = store.save(
              { app: appName, content: String(args.content ?? ''), summary: typeof args.summary === 'string' ? args.summary : undefined, match: Array.isArray(args.match) ? args.match : undefined },
              { overwrite: args.overwrite === true },
            )
            return {
              action, ok: true, found: true, app: saved.app, id: saved.id, path: saved.path, chars: saved.chars,
              text: 'Saved the ' + saved.app + ' skill (' + saved.chars + ' characters) at ' + saved.path + '. A screenshot of that app now prints a one-line pointer to it. Keep it short, and overwrite it if a later attempt finds a better route.',
            }
          }
          if (action === 'append') {
            const updated = store.append(appName, String(args.content ?? ''))
            return {
              action, ok: true, found: true, app: updated.app, id: updated.id, path: updated.path, chars: updated.chars,
              text: 'Appended to the ' + updated.app + ' skill; it is now ' + updated.chars + ' characters (cap 4000).',
            }
          }
          const removedApp = store.remove(appName)
          return { action, ok: true, found: true, app: removedApp, text: 'Removed the user skill for ' + removedApp + '. A built-in skill with the same app, if any, applies again.' }
        } catch (cause) {
          const raw = String(cause?.message ?? cause)
          const matched = /^([A-Z][A-Z_]+):/.exec(raw)
          throw new ToolError(matched ? matched[1] : 'SKILL_WRITE_FAILED', raw)
        }
      }
      if (action === 'get') {
        if (!store) {
          return { action, ok: true, found: false, text: 'App skills are disabled in this deployment (skills: false), so there is nothing to look up. Drive the app with computer and ui_element instead.' }
        }
        const appName = typeof args.app === 'string' ? args.app.trim() : ''
        const foreground = runtime.lastView?.foreground ?? null
        const names = appName
          ? [appName]
          : [foreground?.process, foreground?.title, foreground?.class].filter((name) => typeof name === 'string' && name.length > 0)
        if (names.length === 0) {
          return {
            action,
            ok: true,
            found: false,
            text: 'No app was given and there is no recent screenshot to identify the foreground window. Pass app (for example Excel or EXCEL.EXE), or take a computer screenshot first and call this again.',
          }
        }
        const skill = runtime.skillFor(names)
        if (!skill) {
          const available = skills.map((entry) => entry.app)
          return {
            action,
            ok: true,
            found: false,
            available,
            text: 'No skill matched ' + names.join(' / ') + '. Available skills: ' + (available.slice(0, 20).join(', ') || '(none)') + (available.length > 20 ? ', ...' : '') + '. Call action list for the full catalog, or pass an exe or process name such as EXCEL.EXE.',
          }
        }
        const body = 'Skill: ' + skill.app + ' (matched ' + skill.match.join(', ') + ')\n' + (skill.summary ? skill.summary + '\n' : '') + '---\n' + skill.content
        return {
          action,
          ok: true,
          found: true,
          app: skill.app,
          match: skill.match,
          summary: skill.summary,
          chars: skill.chars,
          source: skill.source,
          path: skill.path,
          content: skill.content,
          text: body.length > 6000 ? body.slice(0, 6000) + '\n[skill truncated for display]' : body,
        }
      }

      throw new ToolError('UNKNOWN_ACTION', 'Unknown action ' + action + '. Use list or get.')
    },
  }
}




