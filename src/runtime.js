/**
 * Shared runtime for every computer-use tool.
 *
 * Owns the long-lived Windows host process, the visible overlay + Esc guard, the
 * coordinate space defined by the most recent screenshot, and the safety gates
 * every mutating action passes through. One runtime per plugin instance (one per
 * DSH profile), not per session: the desktop is a single global resource.
 *
 * The module itself imports nothing outside `node:` builtins, so the plugin
 * installs with zero dependencies and cannot be broken by a peer-version skew.
 * The Windows backend and the overlay guard are loaded lazily and are allowed to
 * fail independently: a missing overlay degrades to "no overlay", a missing
 * backend fails only the tools that need it.
 * @module dsh-computer-use/runtime
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { SkillStore, MAX_SKILL_CHARS } from './skills.js'
import { OcrHost } from './win/ocr.mjs'

/** Actions that change the desktop, i.e. the ones the safety gates apply to. */
export const MUTATING_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click', 'move',
  'drag', 'scroll', 'type', 'key',
  'app_focus', 'app_launch', 'app_close', 'app_minimize',
  'ui_invoke', 'ui_set_value', 'ui_focus', 'ui_expand', 'ui_collapse', 'ui_select',
  'clipboard_set',
])

/** Deployment defaults for every documented configuration key. */
export const CONFIG_DEFAULTS = {
  enabled: true,
  screenshot: { maxWidth: 1280, maxPixels: 600000, format: 'jpeg', jpegQuality: 80, saveToDisk: true },
  coordinates: 'image',
  uiSummary: 'summary',
  uiSummaryMaxNodes: 60,
  uiSummaryMaxChars: 4000,
  overlay: 'auto',
  overlayOpacity: 0.85,
  overlayMessage: 'DeepSeek Harness is controlling your computer - press Esc to stop',
  escStop: true,
  dryRun: false,
  requireApproval: 'never',
  allowLaunch: true,
  allowCloseWindow: true,
  actionDelayMs: 60,
  requestTimeoutMs: 20000,
  screenshotTimeoutMs: 30000,
  idleDisarmMs: 60000,
  blocklist: [],
  skills: true,
  skillsDir: null,
  skillsHint: true,
  ocrLang: 'auto',
  ocrMaxLines: 200,
}

/**
 * Render the host's `change` record as a verdict the model can act on.
 * @param change - `{comparable, changed, ratio, bounds, sample}` or null.
 * @returns {string[]} zero or more lines for the model-facing text.
 */
export function describeChange(change) {
  if (!change || typeof change !== 'object') return []
  if (change.comparable === false) {
    return ['No previous capture of this target to compare against, so whether anything changed is unknown; take another screenshot after the next action to enable the comparison.']
  }
  if (change.changed !== true) {
    return ['Screen verdict: NO visible change since the previous capture (' + ((Number(change.ratio) || 0) * 100).toFixed(1) + '% of sampled pixels differ). If this followed an action, that action probably did nothing - re-read the screenshot instead of repeating the same click.']
  }
  const pct = ((Number(change.ratio) || 0) * 100).toFixed(1)
  const b = change.bounds
  const where = b ? ` in region (${b.x},${b.y}) ${b.width}x${b.height}` : ''
  return [`Screen verdict: CHANGED - ${pct}% of sampled pixels differ from the previous capture${where}.`]
}

/** A tool failure with a stable machine code and a model-actionable message. */
export class ToolError extends Error {
  /**
   * @param code - stable upper-snake code surfaced to the model.
   * @param message - directive message telling the model what to do next.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/**
 * Deep-merge the deployment's configuration over {@link CONFIG_DEFAULTS} and
 * narrow the enumerated keys, so a typo in YAML degrades to the default instead
 * of an undefined tool behaviour.
 * @param raw - the `config:` object from the bundle row.
 * @returns a complete, validated configuration.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'string' ? Number(value) : value
    return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const shot = input.screenshot && typeof input.screenshot === 'object' ? input.screenshot : {}
  return {
    ...CONFIG_DEFAULTS,
    ...input,
    enabled: input.enabled !== false,
    screenshot: {
      maxWidth: num(shot.maxWidth, CONFIG_DEFAULTS.screenshot.maxWidth, 64, 8192),
      maxPixels: num(shot.maxPixels, CONFIG_DEFAULTS.screenshot.maxPixels, 65536, 16777216),
      format: oneOf(String(shot.format ?? '').toLowerCase(), ['png', 'jpeg'], 'jpeg'),
      jpegQuality: num(shot.jpegQuality, 80, 10, 100),
      saveToDisk: shot.saveToDisk !== false,
    },
    coordinates: oneOf(input.coordinates, ['image', 'physical'], 'image'),
    uiSummary: oneOf(input.uiSummary, ['none', 'summary', 'tree'], 'summary'),
    overlay: oneOf(input.overlay, ['auto', 'always', 'never'], 'auto'),
    overlayOpacity: num(input.overlayOpacity, 0.85, 0.05, 1),
    escStop: input.escStop !== false,
    dryRun: input.dryRun === true,
    requireApproval: oneOf(input.requireApproval, ['never', 'mutating'], 'never'),
    allowLaunch: input.allowLaunch !== false,
    allowCloseWindow: input.allowCloseWindow !== false,
    actionDelayMs: num(input.actionDelayMs, 60, 0, 5000),
    requestTimeoutMs: num(input.requestTimeoutMs, 20000, 1000, 600000),
    screenshotTimeoutMs: num(input.screenshotTimeoutMs, 30000, 1000, 600000),
    idleDisarmMs: num(input.idleDisarmMs, 60000, 0, 3600000),
    blocklist: Array.isArray(input.blocklist) ? input.blocklist.filter((s) => typeof s === 'string' && s.length > 0) : [],
    skills: input.skills !== false,
    skillsDir: typeof input.skillsDir === 'string' && input.skillsDir.length > 0 ? input.skillsDir : null,
    skillsHint: input.skillsHint !== false,
    ocrLang: typeof input.ocrLang === 'string' && input.ocrLang.length > 0 ? input.ocrLang : 'auto',
    ocrMaxLines: num(input.ocrMaxLines, 200, 1, 2000),
  }
}

/**
 * Where a deployment drops its own app skills. Honours `DSH_HOME` so the user
 * layer lands in the same home the running harness uses (a machine can have
 * more than one).
 * @returns the user skill directory path.
 */
export function defaultSkillsDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'computer-use-skills')
}

/** Monotonic-ish file stamp for screenshot spill names. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}


/** Depth-first search over a UI Automation outline. */
function findNode(node, predicate) {
  if (!node) return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return undefined
}

export class ComputerRuntime {
  /**
   * @param context - the cordis plugin context (`ctx`).
   * @param config - the normalized configuration (see {@link normalizeConfig}).
   */
  constructor(context, config) {
    this.context = context
    this.config = config
    this.log = (level, message, extra) => {
      const sink = context.logger?.[level] ?? context.logger?.info
      if (typeof sink === 'function') sink.call(context.logger, `[computer-use] ${message}`, extra)
      else if (level === 'error') process.stderr.write(`[computer-use] ${message}\n`)
    }
    /** @type {{width:number,height:number,scale:number,capture:{x:number,y:number,width:number,height:number},screen:{width:number,height:number},at:string}|null} */
    this.lastView = null
    /** Set once a human pressed Esc; blocks every mutating action until resume. */
    this.tripped = null
    /** Number of tool calls that mutated the desktop in this plugin instance. */
    this.mutations = 0
    /** Unexpected automation-host deaths seen in this plugin instance. */
    this.hostRestarts = 0
    this.overlayArmed = false
    this.overlayError = null
    this.hostState = 'stopped'
    this.hostError = null
    this.guardState = 'stopped'
    this.disarmTimer = null
    this.lastActionAt = 0
    this.hostPromise = null
    this.host = null
    this.guardPromise = null
    this.guard = null
    this.starting = null
    /**
     * Per-application skill library (how to drive Excel, Chrome, VS Code, ...).
     * Built-ins ship with the package; `skillsDir` adds a user layer that
     * overrides them by id. Null when the deployment disabled skills.
     * @type {SkillStore|null}
     */
    this.skillStore = config.skills ? new SkillStore({ userDir: config.skillsDir ?? defaultSkillsDir() }) : null
    this.ocrHost = null
    this.ocrStarting = null
    /** Resident Windows OCR helper (PS 5.1 WinRT), started on first use. */
    this.ocrHost = null
    this.ocrStarting = null
  }

  async ensureOcr() {
    if (this.ocrHost) return this.ocrHost
    if (this.ocrStarting) return this.ocrStarting
    this.ocrStarting = (async () => {
      const host = new OcrHost({ log: this.log })
      await host.start()
      this.ocrHost = host
      this.log('info', 'ocr helper ready')
      return host
    })()
    try { return await this.ocrStarting } finally { this.ocrStarting = null }
  }

  async recognize(options = {}) {
    const shot = await this.call('screenshot', { screen: options.screen ?? null, hwnd: options.hwnd ?? null, region: options.region ?? null, maxWidth: null, maxPixels: null, format: 'png' }, { timeoutMs: this.config.screenshotTimeoutMs })
    const dir = join(tmpdir(), 'dsh-computer-use', 'ocr')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    await writeFile(file, Buffer.from(shot.image.base64, 'base64'))
    try {
      const host = await this.ensureOcr()
      const raw = await host.recognize(file, { lang: options.lang ?? this.config.ocrLang, maxLines: options.maxLines ?? this.config.ocrMaxLines })
      const scale = shot.scale || 1
      const origin = shot.capture ?? { x: 0, y: 0 }
      const lines = (raw.lines ?? []).map((line) => ({ text: line.text, words: line.words ?? 0, bounds: { x: Math.round(origin.x + line.bounds.x / scale), y: Math.round(origin.y + line.bounds.y / scale), width: Math.round(line.bounds.width / scale), height: Math.round(line.bounds.height / scale) } }))
      return { engine: raw.engine, lang: raw.lang, text: lines.map((line) => line.text).join('\n'), lines, capture: shot.capture, elapsedMs: raw.elapsedMs }
    } finally { await rm(file, { force: true }).catch(() => {}) }
  }

  async waitFor(options = {}) {
    const kind = options.kind ?? 'stable'
    const timeoutMs = Math.min(600000, Math.max(100, Number(options.timeoutMs ?? 8000)))
    const intervalMs = Math.min(5000, Math.max(50, Number(options.intervalMs ?? 250)))
    const stableMs = Math.min(60000, Math.max(0, Number(options.stableMs ?? 600)))
    // A desktop is almost never byte-identical twice (a caret blinks, a clock
    // ticks, a spinner spins), so "stable" is measured as "barely moved" on the
    // same down-sampled frame signature the verify path uses.
    const stableRatio = Math.min(1, Math.max(0, Number(options.ratio ?? 0.002)))
    const started = Date.now()
    let lastRatio = null
    let stableHwnd
    let stableSince = null
    let frames = 0
    while (Date.now() - started < timeoutMs) {
      if (this.tripped) throw new ToolError('STOPPED_BY_HUMAN', 'A human pressed Esc while waiting, so the wait stopped.')
      frames += 1
      if (kind === 'stable') {
        if (stableHwnd === undefined) { const listed = await this.call('windows', {}); stableHwnd = (listed.windows ?? []).find((win) => win.foreground === true)?.hwnd ?? null }
        const shot = await this.call('screenshot', { hwnd: options.hwnd ?? stableHwnd, maxWidth: 480, format: 'jpeg', quality: 55, compare: true }, { timeoutMs: this.config.screenshotTimeoutMs })
        const change = shot.image?.change
        lastRatio = change?.comparable === true ? Number(change.ratio) || 0 : null
        if (lastRatio !== null && lastRatio <= stableRatio) {
          stableSince ??= Date.now()
          if (Date.now() - stableSince >= stableMs) return { ok: true, kind, waitedMs: Date.now() - started, frames, ratio: lastRatio }
        } else { stableSince = null }
      } else if (kind === 'window') {
        const listed = await this.call('windows', { filter: options.titleMatch ?? '' })
        const target = String(options.titleMatch ?? '').toLowerCase()
        const match = (listed.windows ?? []).find((win) => String(win.title ?? '').toLowerCase().includes(target))
        if (match) return { ok: true, kind, waitedMs: Date.now() - started, frames, window: match }
      } else if (kind === 'element') {
        const tree = await this.call('uia', { hwnd: options.hwnd ?? null, depth: 8, maxNodes: 1500, includeOffscreen: false })
        const needle = String(options.name ?? '').toLowerCase()
        const hit = findNode(tree.root, (node) => `${node.name ?? ''} ${node.automationId ?? ''}`.toLowerCase().includes(needle))
        if (hit) return { ok: true, kind, waitedMs: Date.now() - started, frames, element: { role: hit.role, name: hit.name, path: hit.path, bounds: hit.bounds } }
      } else if (kind === 'text') {
        const seen = await this.recognize({ lang: options.lang, hwnd: options.hwnd ?? null })
        const needle = String(options.text ?? '').toLowerCase().replace(/\s+/g, '')
        const hit = (seen.lines ?? []).find((line) => String(line.text).toLowerCase().replace(/\s+/g, '').includes(needle))
        if (hit) return { ok: true, kind, waitedMs: Date.now() - started, frames, line: hit }
      } else {
        throw new ToolError('UNKNOWN_WAIT_KIND', 'Unknown wait kind "' + kind + '"; use stable, window, element or text.')
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    const hint = kind === 'stable' && lastRatio !== null && lastRatio > stableRatio
      ? ' The screen keeps changing (' + (lastRatio * 100).toFixed(1) + '% of sampled pixels between frames), so something on it is animating: wait for a specific element or text instead, or raise the timeout.'
      : ''
    return { ok: false, kind, waitedMs: Date.now() - started, frames, ratio: lastRatio, error: { code: 'WAIT_TIMEOUT', message: 'Nothing matched within ' + timeoutMs + 'ms.' + hint } }
  }
  /** @returns {string} directory screenshot spill files land in. */
  screenshotDir() {
    return join(tmpdir(), 'dsh-computer-use', 'screenshots')
  }

  /**
   * Start the Windows host once (single-flight) and return it.
   * @returns {Promise<object>} the `WinHost` client.
   */
  async ensureHost() {
    if (this.host) return this.host
    if (this.starting) return this.starting
    this.hostState = 'starting'
    this.starting = (async () => {
      let mod
      try {
        mod = await import('./win/backend.mjs')
      } catch (cause) {
        this.hostState = 'failed'
        this.hostError = cause
        throw new ToolError(
          'BACKEND_MISSING',
          `The Windows automation backend (src/win/backend.mjs) could not be loaded: ${cause?.message ?? cause}`,
        )
      }
      const Host = mod.WinHost ?? mod.default
      if (typeof Host !== 'function') {
        this.hostState = 'failed'
        throw new ToolError('BACKEND_INVALID', 'src/win/backend.mjs does not export a WinHost class')
      }
      const host = new Host({ log: this.log })
      try {
        await host.start()
      } catch (cause) {
        this.hostState = 'failed'
        this.hostError = cause
        throw new ToolError('BACKEND_START_FAILED', `The Windows automation host failed to start: ${cause?.message ?? cause}`)
      }
      this.host = host
      this.hostState = 'ready'
      this.log('info', `windows host ready (${JSON.stringify(host.hostInfo ?? {})})`)
      if (typeof host.on === 'function') {
        host.on('abort', (payload) => this.handleEsc(payload))
        host.on('event', (message) => {
          if (message?.event === 'abort') this.handleEsc(message.result)
        })
        host.on('exit', (info) => {
          this.hostState = 'stopped'
          this.host = null
          this.starting = null
          this.log(info?.expected ? 'info' : 'error', `windows host exited (${JSON.stringify(info ?? {})})`)
          // An unexpected death of the automation process is a stop signal, not a
          // hiccup to paper over: the backend may auto-restart, but the human (or
          // the model, after asking them) has to clear the kill switch first.
          if (info?.expected !== true) {
            this.hostRestarts += 1
            this.trip('host-exited')
          }
        })
      }
      return host
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * One request against the Windows host.
   * @param cmd - protocol command name.
   * @param args - command arguments.
   * @param options - `{timeoutMs}`.
   * @returns {Promise<object>} the protocol `result` object.
   */
  async call(cmd, args = {}, options = {}) {
    const host = await this.ensureHost()
    if (this.config.overlay === 'always' && !this.overlayArmed) await this.ensureOverlay()
    return host.call(cmd, args, { timeoutMs: options.timeoutMs ?? this.config.requestTimeoutMs })
  }

  /** @returns {Promise<{armed:boolean,tripped:boolean,reason:string|null}>} guard status. */
  async guardStatus() {
    return { armed: this.overlayArmed, tripped: Boolean(this.tripped), reason: this.tripped?.reason ?? null, since: this.tripped?.at ?? null }
  }

  /** Load the overlay guard module (single-flight, failure is not fatal). */
  async ensureGuard() {
    if (this.guard) return this.guard
    if (this.guardPromise) return this.guardPromise
    this.guardPromise = (async () => {
      let mod
      try {
        mod = await import('./overlay/guard.mjs')
      } catch (cause) {
        this.overlayError = String(cause?.message ?? cause)
        this.guardState = 'unavailable'
        this.log('error', `overlay guard unavailable: ${this.overlayError}`)
        return null
      }
      const Guard = mod.Guard ?? mod.default
      if (typeof Guard !== 'function') {
        this.overlayError = 'guard.mjs exports no Guard class'
        this.guardState = 'unavailable'
        return null
      }
      const guard = new Guard({ log: this.log })
      guard.on('abort', (payload) => this.handleEsc(payload))
      guard.on('exit', (info) => {
        this.overlayArmed = false
        this.guardState = 'stopped'
        // The indicator dying on its own (not through disarm(), not through Esc)
        // means the human can no longer SEE or STOP the agent, so every mutating
        // action freezes until someone deliberately resumes.
        if (info?.unexpected === true) this.trip('guard-exited')
      })
      this.guard = guard
      this.guardState = 'ready'
      return guard
    })()
    try {
      return await this.guardPromise
    } finally {
      this.guardPromise = null
    }
  }

  /**
   * Show the on-screen indicator because a mutating action is about to run.
   * Only ever called for mutating actions, and only when the deployment asked for
   * an overlay; a failure here must never block the action.
   * @returns {Promise<void>}
   */
  async ensureOverlay() {
    if (this.config.overlay === 'never' || this.overlayArmed) return
    const guard = await this.ensureGuard()
    if (!guard) return
    try {
      await guard.arm({
        message: this.config.overlayMessage,
        opacity: this.config.overlayOpacity,
        mode: 'both',
        disableHotkey: !this.config.escStop,
      })
      this.overlayArmed = true
      this.guardState = 'armed'
    } catch (cause) {
      this.overlayError = String(cause?.message ?? cause)
      this.log('error', `overlay failed to arm: ${this.overlayError}`)
    }
  }

  /** Reset the idle timer that takes the indicator down again. */
  touchIdleTimer() {
    this.lastActionAt = Date.now()
    if (this.config.overlay !== 'auto' || !this.overlayArmed) return
    if (this.disarmTimer) clearTimeout(this.disarmTimer)
    if (this.config.idleDisarmMs <= 0) return
    this.disarmTimer = setTimeout(() => {
      this.disarmTimer = null
      if (Date.now() - this.lastActionAt >= this.config.idleDisarmMs) void this.disarmOverlay()
    }, this.config.idleDisarmMs)
    this.disarmTimer.unref?.()
  }

  /** Take the indicator down (idempotent). */
  async disarmOverlay() {
    if (this.disarmTimer) {
      clearTimeout(this.disarmTimer)
      this.disarmTimer = null
    }
    if (!this.overlayArmed || !this.guard) return
    this.overlayArmed = false
    this.guardState = this.guard ? 'ready' : 'unavailable'
    try {
      await this.guard.disarm()
    } catch (cause) {
      this.log('error', `overlay failed to disarm: ${cause?.message ?? cause}`)
    }
  }

  /**
   * Record a human Esc press. Every mutating action afterwards fails closed until
   * the model calls `computer` with action `resume` (which requires a fresh
   * decision by the human, so a tripped runtime never resumes itself).
   * @param payload - the guard's abort payload.
   */
  handleEsc(payload) {
    const at = new Date().toISOString()
    this.tripped = { reason: payload?.reason ?? 'escape', at: payload?.at ?? at }
    this.overlayArmed = false
    this.log('info', 'Esc kill switch tripped: mutating actions are blocked')
  }

  /**
   * Freeze mutating actions for a reason other than Esc (the indicator or the
   * automation host died unexpectedly). Idempotent: the first reason wins.
   * @param reason - short machine reason recorded with the trip.
   */
  trip(reason) {
    if (this.tripped) return
    this.tripped = { reason, at: new Date().toISOString() }
    this.log('error', `kill switch tripped unexpectedly: ${reason}`)
  }

  /** Clear the kill switch (only reachable through the `resume` action). */
  resume() {
    const was = this.tripped
    this.tripped = null
    return was
  }

  /**
   * Gate one mutating action: Esc state, dry-run, approval policy, and the
   * blocklist. Throws a {@link ToolError} instead of touching the desktop when the
   * action must not run.
   * @param toolName - the tool asking for permission.
   * @param label - short human description of what is about to happen.
   * @param exec - the tool execution context (for approval correlation).
   * @returns {Promise<{dryRun:boolean}>}
   */
  async beforeMutation(toolName, label, exec) {
    if (this.tripped) {
      throw new ToolError(
        'STOPPED_BY_HUMAN',
        `A human pressed Esc at ${this.tripped.at}, so the desktop is frozen: "${label}" was NOT performed. Stop and report what you were doing, or continue with read-only actions (screenshot, app_window list, ui_element tree).`,
      )
    }
    await this.verifyTargetWindow()
    this.ensureBlocklist(label)
    if (this.config.requireApproval === 'mutating') {
      await this.requestApproval(toolName, label, exec)
    }
    if (this.config.dryRun) return { dryRun: true }
    await this.ensureOverlay()
    this.touchIdleTimer()
    this.mutations += 1
    return { dryRun: false }
  }

  /**
   * Refuse to act on a stale observation: when the last screenshot was captured
   * against one specific window, that window may have been moved, resized,
   * closed, or replaced by a restart in between. Acting anyway clicks whatever is
   * there now, which is exactly the silent mis-click this guard exists to stop.
   * Degrades to a no-op on hosts that predate the `windowState` command.
   * @returns {Promise<void>}
   */
  async verifyTargetWindow() {
    const recorded = this.lastView?.window
    if (!recorded) return
    let state
    try {
      state = await this.call('windowState', { hwnd: recorded.hwnd }, { timeoutMs: 5000 })
    } catch {
      return
    }
    if (state === undefined || state === null) return
    if (state.exists === false) {
      throw new ToolError(
        'TARGET_WINDOW_GONE',
        `The window this screenshot came from (hwnd ${recorded.hwnd}) no longer exists, so nothing was performed. Take a fresh screenshot and re-derive the target.`,
      )
    }
    if (recorded.pid && state.pid && state.pid !== recorded.pid) {
      throw new ToolError(
        'TARGET_WINDOW_CHANGED',
        `hwnd ${recorded.hwnd} now belongs to a different process (pid ${state.pid}, was ${recorded.pid}): the app was restarted and the old coordinates are meaningless. Take a fresh screenshot.`,
      )
    }
    const was = recorded.bounds
    const now = state.bounds
    if (was && now) {
      const dx = Math.round(now.x - was.x)
      const dy = Math.round(now.y - was.y)
      const dw = Math.round(now.width - was.width)
      const dh = Math.round(now.height - was.height)
      if (dx !== 0 || dy !== 0 || dw !== 0 || dh !== 0) {
        throw new ToolError(
          'TARGET_WINDOW_MOVED',
          `The window moved or resized since the last screenshot (dx=${dx}, dy=${dy}, dw=${dw}, dh=${dh}); the coordinates you derived no longer point at the same pixels, so nothing was performed. Take a fresh screenshot, then act.`,
        )
      }
    }
  }

  /**
   * Reject an action aimed at a blocklisted window (e.g. a password manager).
   * @param label - the action description, matched case-insensitively.
   */
  ensureBlocklist(label) {
    if (this.config.blocklist.length === 0) return
    const haystack = String(label ?? '').toLowerCase()
    for (const needle of this.config.blocklist) {
      if (haystack.includes(needle.toLowerCase())) {
        throw new ToolError('BLOCKED_TARGET', `This deployment blocks computer use on targets matching "${needle}"; the action was not performed.`)
      }
    }
  }

  /**
   * Ask the harness approval service (only when `requireApproval` says so).
   * A deployment whose approval policy is `never` resolves every ask as
   * rejected, so this gate is off by default.
   * @param toolName - tool asking.
   * @param label - human description.
   * @param exec - execution context.
   * @returns {Promise<void>}
   */
  async requestApproval(toolName, label, exec) {
    const service = this.context.get?.('approval')
    if (service === undefined || service === null || typeof service.request !== 'function') {
      throw new ToolError('APPROVAL_UNAVAILABLE', 'This deployment requires approval for desktop actions but no approval service is available, so nothing was performed.')
    }
    const outcome = await service.request({
      agent: exec?.agent,
      toolName,
      callId: exec?.callId,
      reason: label,
      signal: exec?.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new ToolError('APPROVAL_DENIED', `The user did not approve "${label}" (${outcome}); nothing was performed.`)
    }
  }

  /**
   * Capture the screen, attach the bytes, and remember the coordinate space.
   * @param options - `{screen, region, hwnd, includeUi, uiSummary, maxWidth, format}`.
   * @returns {Promise<object>} the canonical tool value (image ref + view + text).
   */
  async capture(options = {}) {
    const format = options.format ?? this.config.screenshot.format
    const result = await this.call(
      'screenshot',
      {
        screen: options.screen ?? null,
        hwnd: options.hwnd ?? null,
        region: options.region ?? null,
        maxWidth: options.maxWidth ?? this.config.screenshot.maxWidth,
        maxPixels: options.maxPixels ?? this.config.screenshot.maxPixels,
        format,
        quality: this.config.screenshot.jpegQuality,
        // grid / mark / dim are expressed in IMAGE space - the same space the
        // model reads coordinates in - so they are forwarded without conversion.
        grid: options.grid === true,
        gridStep: Number.isFinite(Number(options.gridStep)) ? Number(options.gridStep) : 0,
        mark: options.mark ?? null,
        dim: options.dim ?? null,
        // compare: diff this capture against the previous one of the same target.
        compare: options.compare === true,
      },
      { timeoutMs: this.config.screenshotTimeoutMs },
    )
    const view = {
      width: result.image.width,
      height: result.image.height,
      scale: result.scale,
      capture: result.capture,
      screen: result.screen,
      at: new Date().toISOString(),
      // Identity of what the model is looking at, so an action can be refused if
      // the world changed between the observation and the click.
      foreground: result.foreground ?? null,
      window: options.hwnd ? { hwnd: options.hwnd, bounds: { ...result.capture }, pid: result.window?.pid ?? null } : null,
    }
    this.lastView = view
    const attached = options.attach === false
      ? { ref: null, savedPath: null, attached: false }
      : { ...(await this.attachImage(result.image, view)), attached: true }
    const uiMode = options.uiSummary ?? this.config.uiSummary
    let ui = null
    if (uiMode !== 'none') {
      ui = await this.uiSummary(options.hwnd ?? null, uiMode === 'tree' ? 8 : 4, uiMode === 'tree' ? 2000 : this.config.uiSummaryMaxNodes)
    }
    return {
      action: 'screenshot',
      ok: true,
      text: this.describeCapture(view, result, attached, ui),
      image: attached.ref,
      savedPath: attached.savedPath,
      view,
      cursor: result.cursor ?? null,
      change: result.image?.change ?? null,
      fallback: result.fallback ?? null,
      ui,
    }
  }

  /**
   * Turn the host's frame-diff record into one sentence the model can act on.
   * "The click did nothing" is the single most useful thing a screenshot taken
   * after an action can say, so it is phrased as a verdict, not as a statistic.
   * @param change - the `change` object from the host, or null.
   * @returns {string[]} zero or more lines to append to the capture summary.
   */
  static describeChange(change) {
    return describeChange(change)
  }

  /**
   * Build the text half of a screenshot result. This is the whole observation
   * channel for a text-only model, so it always names the coordinate space, the
   * cursor, the focused window, and (when enabled) an accessible outline of it.
   * @param view - recorded coordinate space.
   * @param result - raw protocol screenshot result.
   * @param attached - `{ref, savedPath}` from {@link attachImage}.
   * @param ui - bounded UI Automation summary, or null.
   * @returns the model-facing summary text.
   */
  describeCapture(view, result, attached, ui) {
    const lines = []
    lines.push(`Screenshot ${view.width}x${view.height}px (image space; ${view.capture.width}x${view.capture.height} physical captured at (${view.capture.x},${view.capture.y}), scale ${Number(view.scale).toFixed(4)}).`)
    lines.push('Pass x/y to click/move/drag/scroll in THIS image\'s pixel space with (0,0) at the top-left; the plugin converts them to physical pixels.')
    if (result.cursor) {
      const ix = Math.round((result.cursor.x - view.capture.x) * view.scale)
      const iy = Math.round((result.cursor.y - view.capture.y) * view.scale)
      lines.push(`Cursor: physical (${result.cursor.x},${result.cursor.y}) = image (${ix},${iy}).`)
    }
    lines.push(...describeChange(result.image?.change ?? null))
    if (result.fallback === 'screen') lines.push('Note: the requested window could not be captured directly, so the whole display was captured instead.')
    if (this.config.skillsHint) {
      const hint = this.skillHint(result.foreground)
      if (hint) lines.push(hint)
    }
    if (ui?.lines?.length) {
      lines.push(`Focused window: ${ui.role}${ui.name ? ` "${ui.name}"` : ''} - ${ui.nodes}${ui.truncated ? '+' : ''} accessible nodes.`)
      lines.push(...ui.lines)
      if (ui.truncated) lines.push('[outline truncated; call ui_element tree with a lower maxDepth, or ui_element find for a specific control]')
    } else if (ui?.error) {
      lines.push(`UI Automation unavailable for this window: ${ui.error}`)
    }
    if (!attached.ref) {
      lines.push(`No image attached by the harness; the capture was saved to ${attached.savedPath ?? '(nowhere)'} instead. Reason from the text above.`)
    }
    return lines.join('\n')
  }
  /**
   * Persist screenshot bytes as a durable harness attachment when the deployment
   * has one, else spill to disk so the model still gets a handle it can read.
   * @param image - protocol image `{base64,mime,width,height}`.
   * @param view - the recorded coordinate space (for the display name).
   * @returns {Promise<{ref:object|null,savedPath:string|null}>}
   */
  async attachImage(image, view) {
    const bytes = Buffer.from(image.base64, 'base64')
    const name = `desktop-${view.width}x${view.height}-${stamp()}.${image.mime === 'image/jpeg' ? 'jpg' : 'png'}`
    const store = this.context.get?.('attachments')
    if (store && typeof store.saveImage === 'function') {
      try {
        const saved = await store.saveImage({ data: new Uint8Array(bytes), mediaType: image.mime, name })
        let savedPath = null
        try {
          savedPath = store.imageHostPath?.(saved) ?? null
        } catch {
          savedPath = null
        }
        return { ref: { ...saved }, savedPath }
      } catch (cause) {
        this.log('error', `attachment save failed, falling back to disk: ${cause?.message ?? cause}`)
      }
    }
    if (!this.config.screenshot.saveToDisk) return { ref: null, savedPath: null }
    const dir = this.screenshotDir()
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, bytes)
    return { ref: null, savedPath: file }
  }

  /**
   * UI Automation outline of one window, bounded in nodes and characters.
   * @param hwnd - target window handle, `null` for the foreground window.
   * @param depth - maximum tree depth.
   * @param maxNodes - maximum nodes to walk.
   * @returns {Promise<{role:string,name:string,lines:string[],nodes:number,truncated:boolean}|null>}
   */
  async uiSummary(hwnd, depth, maxNodes) {
    try {
      const tree = await this.call('uia', { hwnd, depth, maxNodes, includeOffscreen: false })
      const lines = []
      let chars = 0
      let nodes = 0
      const walk = (node, level) => {
        if (lines.length >= this.config.uiSummaryMaxNodes * 3) return
        const label = node.name || node.value || node.automationId || ''
        const actionable = (node.patterns ?? []).length > 0
        if (label || actionable) {
          const line = `${'  '.repeat(level)}${node.role}${label ? ` "${String(label).slice(0, 120)}"` : ''}${node.offscreen ? ' (offscreen)' : ''} [${node.path}]`
          if (chars + line.length > this.config.uiSummaryMaxChars) return
          chars += line.length + 1
          lines.push(line)
          nodes += 1
        }
        for (const child of node.children ?? []) walk(child, label ? level + 1 : level)
      }
      walk(tree.root, 0)
      return { role: tree.root?.role ?? 'Window', name: tree.root?.name ?? '', lines, nodes, truncated: Boolean(tree.truncated) }
    } catch (cause) {
      return { error: String(cause?.message ?? cause) }
    }
  }

  /**
   * The app skill that applies to a window or a list of names.
   * @param names - process, title, class, or app name, in priority order.
   * @returns the matching skill, or undefined.
   */
  skillFor(names) {
    if (!this.skillStore) return undefined
    const list = Array.isArray(names) ? names : [names]
    return this.skillStore.find(list.filter((name) => typeof name === 'string' && name.length > 0))
  }

  /**
   * One-line pointer to the skill for the app in front, so a text-only model
   * learns the shortcut recipe exists without paying for the whole body.
   * @param foreground - the protocol foreground window record, when available.
   * @returns a hint line, or an empty string.
   */
  skillHint(foreground) {
    if (!this.skillStore || !foreground) return ''
    const skill = this.skillFor([foreground.process, foreground.title, foreground.class])
    if (!skill) return ''
    return `App skill available for ${skill.app}${skill.summary ? ` (${skill.summary})` : ''}: call app_skill with action "get" and app "${skill.app}" BEFORE driving this app - it lists the reliable shortcuts, capped at ${MAX_SKILL_CHARS} characters.`
  }

  /**
   * One line per loaded skill, for a tool description.
   * @returns the catalog lines, or an empty string.
   */
  skillCatalog() {
    return this.skillStore ? this.skillStore.catalog() : ''
  }

  /**
   * Map a model-supplied coordinate into physical screen pixels.
   * The model reads coordinates off the screenshot it was given, which may be
   * downscaled, so image space is the default contract.
   * @param x - model x, or null.
   * @param y - model y, or null.
   * @returns {{x:number|null,y:number|null}} physical coordinates.
   */
  toPhysical(x, y) {
    if (x == null && y == null) return { x: null, y: null }
    if (this.config.coordinates === 'physical') return { x, y }
    const view = this.lastView
    if (!view) {
      throw new ToolError(
        'NO_REFERENCE_SCREENSHOT',
        'No screenshot has been taken yet, so a coordinate in image space cannot be mapped. Call computer with action "screenshot" first, then pass coordinates taken from that image.',
      )
    }
    const px = x == null ? null : Math.round(view.capture.x + x / view.scale)
    const py = y == null ? null : Math.round(view.capture.y + y / view.scale)
    return { x: px, y: py }
  }

  /** Release the Windows host and the overlay. Never throws. */
  async dispose() {
    await this.disarmOverlay().catch(() => {})
    if (this.ocrHost) await this.ocrHost.close().catch(() => {})
    const host = this.host
    this.host = null
    this.starting = null
    if (host && typeof host.close === 'function') await host.close().catch(() => {})
    const guard = this.guard
    this.guard = null
    // disarm() is idempotent and also covers "the guard exists but the indicator
    // is already down", which disarmOverlay() short-circuits out of above.
    if (guard) {
      const stop = typeof guard.dispose === 'function' ? guard.dispose.bind(guard) : guard.disarm?.bind(guard)
      if (typeof stop === 'function') await stop().catch(() => {})
    }
    this.hostState = 'stopped'
  }
}













