/**
 * Client for the resident Windows OCR helper (`ocr-host.ps1`).
 *
 * Windows.Media.Ocr only projects cleanly into the in-box PowerShell 5.1 (WinRT
 * async needs the `System.WindowsRuntimeSystemExtensions.AsTask` bridge, which
 * PowerShell 7 does not expose without an extra compile step). So the plugin keeps
 * one quiet `powershell.exe -STA` child alive and feeds it PNG paths: every call
 * after the first costs decode + recognize only.
 * @module dsh-computer-use/win/ocr
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** In-box Windows PowerShell, the only host whose WinRT projection works here. */
const PS51 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Where the helper script lives, next to this module. */
function defaultScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'ocr-host.ps1')
}

/** OCR is a real capability gap on this host, so report it as a typed failure. */
export class OcrUnavailable extends Error {
  constructor(message) {
    super(message)
    this.code = 'OCR_UNAVAILABLE'
  }
}

export class OcrHost {
  /**
   * @param options - `{scriptPath, log, readyTimeoutMs}`.
   */
  constructor(options = {}) {
    this.scriptPath = options.scriptPath ?? defaultScriptPath()
    this.log = options.log ?? (() => {})
    this.readyTimeoutMs = options.readyTimeoutMs ?? 20000
    this.proc = null
    this.ready = null
    this.readyInfo = null
    this.pending = new Map()
    this.buffer = ''
    this.nextId = 0
  }

  /**
   * Start the helper once and resolve with its readiness payload.
   * @returns {Promise<object>} `{ok, engine, lang, languages, maxDimension, pid}`.
   */
  async start() {
    if (this.ready) return this.ready
    if (!existsSync(PS51)) throw new OcrUnavailable(`Windows OCR needs ${PS51}, which is not present on this system`)
    if (!existsSync(this.scriptPath)) throw new OcrUnavailable(`The OCR helper script is missing: ${this.scriptPath}`)
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new OcrUnavailable('The OCR helper did not become ready in time')), this.readyTimeoutMs)
      const settleReady = (info) => {
        clearTimeout(timer)
        this.readyInfo = info
        if (info.ok !== true) {
          reject(new OcrUnavailable(`No OCR engine is installed for this user (engine languages: ${JSON.stringify(info.languages ?? [])})`))
          return
        }
        resolve(info)
      }
      try {
        this.proc = spawn(PS51, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (cause) {
        clearTimeout(timer)
        reject(new OcrUnavailable(`Could not start the OCR helper: ${cause?.message ?? cause}`))
        return
      }
      this.proc.stdout.setEncoding('utf8')
      this.proc.stdout.on('data', (chunk) => this.onData(chunk, settleReady))
      this.proc.stderr.setEncoding('utf8')
      this.proc.stderr.on('data', (chunk) => this.log('error', `ocr helper stderr: ${String(chunk).slice(0, 300)}`))
      this.proc.on('exit', (code) => {
        this.proc = null
        this.ready = null
        for (const [, settle] of this.pending) settle.reject(new OcrUnavailable(`The OCR helper exited (code ${code})`))
        this.pending.clear()
      })
    })
    return this.ready
  }

  /**
   * Route one NDJSON line to its waiter or to the readiness resolver.
   * @param chunk - stdout text.
   * @param settleReady - readiness callback.
   */
  onData(chunk, settleReady) {
    this.buffer += chunk
    let at
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log('error', `ocr helper emitted a non-JSON line: ${line.slice(0, 200)}`)
        continue
      }
      if (message.event === 'ready') {
        settleReady(message.result ?? {})
        continue
      }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message.result)
        else waiter.reject(new OcrUnavailable(message.error?.message ?? 'OCR failed'))
      }
    }
  }

  /**
   * Recognize one PNG file.
   * @param pngPath - absolute path to the image.
   * @param options - `{lang, maxLines, timeoutMs}`.
   * @returns {Promise<object>} `{engine, lang, text, lines, elapsedMs}`.
   */
  async recognize(pngPath, options = {}) {
    await this.start()
    if (!this.proc) throw new OcrUnavailable('The OCR helper is not running')
    const id = String(++this.nextId)
    const timeoutMs = options.timeoutMs ?? 20000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new OcrUnavailable(`OCR timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (cause) => {
          clearTimeout(timer)
          reject(cause)
        },
      })
      this.proc.stdin.write(`${JSON.stringify({ id, cmd: 'ocr', args: { png: pngPath, lang: options.lang ?? 'auto', maxLines: options.maxLines ?? 200 } })}\n`)
    })
  }

  /** Shut the helper down (idempotent, never throws). */
  async close() {
    const proc = this.proc
    this.proc = null
    this.ready = null
    if (!proc) return
    try {
      proc.stdin.write(`${JSON.stringify({ id: 'shutdown', cmd: 'shutdown', args: {} })}\n`)
      proc.stdin.end()
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 1500)
      proc.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
