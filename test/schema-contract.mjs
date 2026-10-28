/**
 * Convention test: the four tool definitions must stay inside the host's
 * enforced JSON Schema subset. The host validates every registered tool with
 * `assertSupportedJsonSchema`, and a violation fails the registration silently
 * from the model's point of view (the tool simply never appears), so this test
 * calls the host's own validator instead of a hand-rolled lookalike.
 *
 * The validator is loaded from an installed DSH package: set `DSH_TOOLS_PATH`
 * to `.../@deepseek-ai/dsh-tools/lib/types/json-schema.js`, or let the test
 * discover it under `$DSH_HOME/profiles/node_modules`. When no host package is
 * reachable the test SKIPs instead of failing a checkout without DSH installed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ComputerRuntime, normalizeConfig } from '../src/runtime.js'
import { createComputerTool, createAppWindowTool, createUiElementTool, createClipboardTool, createAppSkillTool } from '../src/tools.js'

/** Candidate locations of the installed host validator. */
function validatorCandidates() {
  const out = []
  if (process.env.DSH_TOOLS_PATH) out.push(process.env.DSH_TOOLS_PATH)
  const homes = [process.env.DSH_HOME, join(process.env.USERPROFILE ?? '', '.dsh')].filter(Boolean)
  for (const home of homes) out.push(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js'))
  out.push(join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js'))
  return out
}

const found = validatorCandidates().find((path) => path && existsSync(path))
if (!found) {
  console.log('SKIP  no installed @deepseek-ai/dsh-tools found; set DSH_TOOLS_PATH to run the convention test')
  process.exit(0)
}

const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import(pathToFileURL(found).href)
const ctx = { get: () => undefined, logger: { info() {}, error() {} } }
const config = normalizeConfig({})
const runtime = new ComputerRuntime(ctx, config)
const factories = [createComputerTool, createAppSkillTool, createAppWindowTool, createUiElementTool, createClipboardTool]
let failed = 0

for (const factory of factories) {
  const tool = factory(runtime, config)
  try {
    if (tool.parameters?.type !== 'object') throw new Error(`parameters root must be type: object, got ${tool.parameters?.type}`)
    assertObjectJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    const blocks = tool.output.render({ action: 'status' }, { action: 'status', ok: true, text: 'probe' })
    if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0].type !== 'text') throw new Error('render must return content blocks')
    if (typeof tool.execute !== 'function') throw new Error('execute must be a function')
    console.log(`PASS  ${tool.name}: schema subset + output schema + render`)
  } catch (cause) {
    failed += 1
    console.log(`FAIL  ${tool.name}: ${cause?.message ?? cause}`)
    if (cause?.violations) console.log(`      violations: ${JSON.stringify(cause.violations)}`)
  }
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${factories.length - failed}/${factories.length} tool definitions inside the host JSON Schema subset`)
if (failed > 0) process.exitCode = 1
