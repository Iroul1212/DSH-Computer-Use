/**
 * dsh-computer-use — plugin entry point.
 *
 * This module is the face of the bundle: it decides whether the capability can
 * exist on this machine at all, builds the one shared {@link ComputerRuntime}
 * (the desktop is a single global resource, so there is exactly one per plugin
 * instance), and registers the four model-facing tools:
 *
 * - `computer`    — the Codex action surface: screenshot, mouse, keyboard, wait.
 * - `app_window`  — list / focus / launch / close / minimize / maximize / restore.
 * - `ui_element`  — UI Automation tree + act on one control by its path.
 * - `clipboard`   — read what the human copied, or hand them text.
 *
 * Design rules this file exists to enforce:
 *
 * 1. **Nothing starts on boot.** `apply` never spawns PowerShell, never captures
 *    a screenshot, never arms the overlay. The host process is started lazily by
 *    the first tool call (`ensureHost`), so a profile that merely lists the
 *    plugin costs nothing and a broken backend cannot break profile boot.
 * 2. **Clean shutdown.** The runtime owns a long-lived PowerShell child and an
 *    on-screen overlay; both are released through `ctx.effect`, so unloading the
 *    plugin never leaves a stray console window or a floating indicator behind.
 * 3. **Inert off Windows.** `process.platform !== 'win32'` logs once and returns;
 *    no tools are registered, so a shared config across machines still boots.
 * 4. **One JSON-Schema boundary.** The tool factories compile their parameter
 *    maps with toParameterJsonSchema, so what this module registers is already
 *    the JSON Schema the host expects.
 * @module dsh-computer-use
 */
import { ComputerRuntime, normalizeConfig } from './runtime.js'
import { createComputerTool, createAppWindowTool, createUiElementTool, createClipboardTool, createAppSkillTool } from './tools.js'

/** Tool id used for logs, the config row and the overlay message prefix. */
export const name = 'computer-use'

/** The only host service this plugin needs. */
export const inject = ['tools']

/**
 * Register the computer-use tools on one plugin context.
 * @param ctx - the cordis plugin context (`tools`, `effect`, `get`, `logger`).
 * @param config - the raw `config:` object from the bundle row.
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) {
    ctx.logger?.info?.('[computer-use] disabled by config (enabled: false); no tools registered')
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`[computer-use] skipped: desktop control is Windows-only (this host is ${process.platform})`)
    return
  }
  if (typeof ctx?.tools?.register !== 'function') {
    ctx.logger?.error?.('[computer-use] no tools service on this context; nothing registered')
    return
  }

  const runtime = new ComputerRuntime(ctx, cfg)
  const tools = [
    createComputerTool(runtime, cfg),
    createAppSkillTool(runtime, cfg),
    createAppWindowTool(runtime, cfg),
    createUiElementTool(runtime, cfg),
    createClipboardTool(runtime, cfg),
  ]

  // The host process and the overlay die with the plugin instance. Registered
  // FIRST so its effect is disposed LAST: cordis unwinds effects in reverse
  // order, and the tool disposers below must run while the runtime is still
  // alive (they only unregister callbacks, but ordering them this way keeps the
  // teardown honest if a tool ever grows a `dispose` of its own).
  ctx.effect(() => () => runtime.dispose())

  const disposers = []
  for (const tool of tools) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (cause) {
      ctx.logger?.error?.(`[computer-use] failed to register tool "${tool.name}": ${cause?.message ?? cause}`)
    }
  }
  // `register` returns its own disposer, but cordis also disposes registrations
  // made through the context it manages; calling the disposers is therefore
  // belt-and-braces, in reverse registration order, and every call is idempotent
  // by contract. If a host returns nothing, the context's own cleanup is enough.
  ctx.effect(() => () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        /* the context is going away; a failing unregister must not mask that */
      }
    }
  })

  const registered = tools.map((tool) => tool.name).join(', ')
  ctx.logger?.info?.(
    `[computer-use] registered ${tools.length} tools: ${registered}; windows host ${runtime.hostState} (lazy: the PowerShell host starts on the first tool call)`,
  )
}


