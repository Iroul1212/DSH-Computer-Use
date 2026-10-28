/**
 * Read-only inspection of the finished plugin: capture the desktop, print the
 * exact text the model would receive, and dump the compiled parameter schemas.
 * Never moves the mouse or types.
 */
import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'
import { createComputerTool, createAppWindowTool, createUiElementTool, createClipboardTool } from '../src/tools.js'

const ctx = { get: () => undefined, logger: { info: (...a) => console.error('[log]', ...a), error: (...a) => console.error('[err]', ...a) } }
const cfg = normalizeConfig({})
const runtime = new ComputerRuntime(ctx, cfg)
const tools = [createComputerTool, createAppWindowTool, createUiElementTool, createClipboardTool]
try {
  const started = Date.now()
  await runtime.ensureHost()
  console.log(`host ready in ${Date.now() - started}ms: ${JSON.stringify(runtime.host?.hostInfo?.screens ?? runtime.host?.hostInfo ?? null).slice(0, 200)}`)
  const shot = await runtime.capture({})
  console.log('--- MODEL-FACING TEXT ---')
  console.log(shot.text)
  console.log('--- END TEXT ---')
  console.log('image ref:', shot.image ? JSON.stringify(shot.image) : 'null (no attachment store)')
  console.log('savedPath:', shot.savedPath)
  for (const factory of tools) {
    const tool = factory(runtime, cfg)
    const p = tool.parameters
    console.log(`${tool.name}: root=${p.type} props=${Object.keys(p.properties).length} required=${JSON.stringify(p.required)} rootAP=${p.additionalProperties} hasRender=${typeof tool.output.render === 'function'}`)
  }
  const windows = await runtime.call('windows', {})
  console.log(`windows: ${windows.windows.length}; first: ${JSON.stringify(windows.windows[0] ?? null).slice(0, 240)}`)
} finally {
  await runtime.dispose()
}
