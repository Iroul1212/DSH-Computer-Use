import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/tools.js'
const raw = readFileSync(p, 'utf8')
const crlf = raw.includes('\r\n')
let s = raw.replace(/\r\n/g, '\n')
function swap(a, b) {
  const n = s.split(a).length - 1
  if (n !== 1) throw new Error('matched ' + n + 'x: ' + a.slice(0, 60))
  s = s.replace(a, b)
}

swap("      grid: {\n        type: 'boolean',\n        description: 'Screenshot: draw a labelled coordinate grid over the image.",
"      waitKind: {\n        type: 'string',\n        enum: ['stable', 'window', 'element', 'text'],\n        description: 'action `wait_for`: what to wait for. `stable` = the window stops changing (frame-diff based, so a blinking caret does not defeat it); `window` = a window matching `titleMatch`; `element` = a control matching `name`; `text` = OCR-visible text matching `text`.',\n      },\n      timeoutMs: { type: 'integer', description: 'action `wait_for`: give up after this many milliseconds (100-600000, default 8000).' },\n      stableMs: { type: 'integer', description: 'action `wait_for` kind `stable`: how long the window must stay quiet before it returns (default 600ms).' },\n      titleMatch: { type: 'string', description: 'action `wait_for` kind `window`: case-insensitive substring of the window title or process name.' },\n      name: { type: 'string', description: 'action `wait_for` kind `element`: case-insensitive substring of a control name or automationId.' },\n      lang: { type: 'string', description: 'action `ocr` / `wait_for` kind `text`: OCR language tag such as \"zh-Hans-CN\" or \"en-US\"; defaults to the deployment setting.' },\n      maxLines: { type: 'integer', description: 'action `ocr`: cap how many recognised lines are returned (1-2000).' },\n      grid: {\n        type: 'boolean',\n        description: 'Screenshot: draw a labelled coordinate grid over the image.")

swap("const waited = await runtime.waitFor({ kind: args.waitKind, timeoutMs: args.timeoutMs, titleMatch: args.titleMatch, name: args.name, text: args.text, hwnd: args.hwnd, lang: args.lang })",
"const waited = await runtime.waitFor({ kind: args.waitKind, timeoutMs: args.timeoutMs, stableMs: args.stableMs, titleMatch: args.titleMatch, name: args.name, text: args.text, hwnd: args.hwnd, lang: args.lang })")

swap("return { action, ok: true, text: 'Waited ' + waited.waitedMs + 'ms for ' + waited.kind + what + ' (' + waited.frames + ' checks).', wait: waited }",
"const quiet = typeof waited.ratio === 'number' ? ' The frame was quiet to ' + (waited.ratio * 100).toFixed(2) + '% of sampled pixels.' : ''\n          return { action, ok: true, text: 'Waited ' + waited.waitedMs + 'ms for ' + waited.kind + what + ' (' + waited.frames + ' checks).' + quiet, wait: waited }")

writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s)
console.log('wait_for/ocr parameters exposed')
