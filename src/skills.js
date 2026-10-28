/**
 * Per-application skill library.
 *
 * A computer-use agent that only sees pixels has to rediscover, every time, that
 * Excel's Name Box accepts `B3`, that F12 opens Save As, or that Chrome's address
 * bar is one Ctrl+L away. That knowledge is small, stable, and app-specific, so
 * it belongs in files the deployment can edit — not in the tool prompt.
 *
 * Layout (front matter + body, no YAML dependency):
 *
 * ```
 * ---
 * app: Excel
 * match: Excel, EXCEL.EXE
 * summary: 单元格录入、公式、另存为、快捷键
 * ---
 * - 定位单元格最稳的方式： ...
 * ```
 *
 * Built-ins ship inside this package; a user directory (see `ComputerRuntime`)
 * may override a built-in with the same id, so a deployment can teach the agent
 * its own tools without forking the plugin.
 * @module dsh-computer-use/skills
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hard cap on one skill's body, in characters, before it reaches the model. */
export const MAX_SKILL_CHARS = 4000

/** Hard cap on how many skills the catalog line lists. */
const MAX_CATALOG_ENTRIES = 40

/** Directory holding the skills that ship with this package. */
export function builtinSkillsDir() {
  return fileURLToPath(new URL('../skills/', import.meta.url))
}

/**
 * Normalize one name for matching: lowercase, no extension, no spaces.
 * `EXCEL.EXE` and `Excel` both become `excel`.
 * @param value - raw app, process or file name.
 * @returns the comparable key.
 */
export function matchKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[\s_-]+/g, '')
    .trim()
}

/**
 * Parse one skill document.
 * @param text - file contents.
 * @param fallbackApp - app name to use when the front matter omits `app`.
 * @returns the parsed skill, or null when the document has no body.
 */
export function parseSkill(text, fallbackApp) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  let app = fallbackApp
  let match = []
  let summary = ''
  let body = source
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (front) {
    body = source.slice(front[0].length)
    for (const line of front[1].split(/\r?\n/)) {
      const at = line.indexOf(':')
      if (at < 0) continue
      const key = line.slice(0, at).trim().toLowerCase()
      const value = line.slice(at + 1).trim()
      if (key === 'app' && value) app = value
      else if (key === 'match' && value) match = value.split(',').map((entry) => entry.trim()).filter(Boolean)
      else if (key === 'summary' && value) summary = value
    }
  }
  body = body.trim()
  if (body.length === 0) return null
  return {
    id: matchKey(app),
    app,
    match: match.length > 0 ? match : [app],
    summary,
    content: body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n[... skill truncated at ${MAX_SKILL_CHARS} characters]` : body,
    chars: Math.min(body.length, MAX_SKILL_CHARS),
  }
}

/**
 * A read-only view over one built-in directory plus one optional user directory.
 * Loaded lazily on first use and cached; `reload()` picks up edits without a
 * plugin restart.
 */
export class SkillStore {
  /**
   * @param options - `{builtinDir, userDir}`; missing directories are ignored.
   */
  constructor(options = {}) {
    this.builtinDir = options.builtinDir ?? builtinSkillsDir()
    this.userDir = options.userDir ?? null
    this.loaded = false
    this.skills = new Map()
    this.errors = []
  }

  /** Read both directories into the cache (idempotent). */
  load() {
    if (this.loaded) return this
    this.skills.clear()
    this.errors = []
    this.readDir(this.builtinDir, 'builtin')
    if (this.userDir) {
      try {
        mkdirSync(this.userDir, { recursive: true })
      } catch {
        /* a read-only deployment simply has no user layer */
      }
      this.readDir(this.userDir, 'user')
    }
    this.loaded = true
    return this
  }

  /**
   * Read every `*.md` in one directory into the cache (user files win).
   * @param dir - directory to scan.
   * @param source - which layer this is.
   */
  readDir(dir, source) {
    if (!dir || !existsSync(dir)) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (cause) {
      this.errors.push(`${dir}: ${cause?.message ?? cause}`)
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      try {
        const skill = parseSkill(readFileSync(join(dir, entry.name), 'utf8'), basename(entry.name, '.md'))
        if (!skill) continue
        this.skills.set(skill.id, { ...skill, source, path: join(dir, entry.name) })
      } catch (cause) {
        this.errors.push(`${entry.name}: ${cause?.message ?? cause}`)
      }
    }
  }

  /** Drop the cache so the next access re-reads the directories. */
  reload() {
    this.loaded = false
    return this.load()
  }

  /** @returns {Array<object>} every loaded skill, sorted by app name. */
  list() {
    this.load()
    return [...this.skills.values()].sort((a, b) => a.app.localeCompare(b.app))
  }

  /** @returns {object|undefined} the skill with this id. */
  get(id) {
    this.load()
    return this.skills.get(matchKey(id))
  }

  /**
   * Find the skill for an app or process name.
   * @param names - app name, exe name, window title, any of them, in priority order.
   * @returns the matching skill, or undefined.
   */
  find(names) {
    this.load()
    const keys = names.filter(Boolean).map(matchKey).filter((key) => key.length > 0)
    if (keys.length === 0) return undefined
    for (const skill of this.skills.values()) {
      for (const candidate of [skill.id, ...skill.match.map(matchKey)]) {
        if (candidate.length === 0) continue
        if (keys.some((key) => key === candidate || key.includes(candidate) || candidate.includes(key))) return skill
      }
    }
    return undefined
  }

  /**
   * One line per skill, short enough to sit inside a tool description.
   * @returns a markdown bullet list, or an empty string when nothing is loaded.
   */
  catalog() {
    const skills = this.list().slice(0, MAX_CATALOG_ENTRIES)
    if (skills.length === 0) return ''
    return skills
      .map((skill) => `- ${skill.app} (${skill.match.join(', ')})${skill.summary ? `: ${skill.summary}` : ''}`)
      .join('\n')
  }

  /** @returns the writable user layer, or throws when this deployment has none. */
  requireUserDir() {
    if (!this.userDir) throw new Error('SKILLS_READ_ONLY: this deployment has no user skill directory, so skills cannot be written')
    mkdirSync(this.userDir, { recursive: true })
    return this.userDir
  }

  /**
   * Serialize one skill back into the canonical on-disk form.
   * @param input - `{app, match, summary, content}`.
   * @returns file contents with front matter.
   */
  static format(input) {
    const match = (Array.isArray(input.match) && input.match.length > 0 ? input.match : [input.app]).join(', ')
    const head = ['---', `app: ${input.app}`, `match: ${match}`]
    if (input.summary) head.push(`summary: ${input.summary}`)
    head.push('---', '')
    return `${head.join('\n')}${input.content.trim()}\n`
  }

  /**
   * Write (or overwrite) one user skill atomically, then re-read the caches.
   * @param input - `{app, match?, summary?, content}`.
   * @param options - `{overwrite}`; without it an existing id is an error.
   * @returns the stored skill.
   */
  save(input, options = {}) {
    const dir = this.requireUserDir()
    const app = String(input?.app ?? '').trim()
    const content = String(input?.content ?? '').trim()
    if (app.length === 0) throw new Error('SKILL_APP_REQUIRED: a skill needs an `app` name')
    if (content.length === 0) throw new Error('SKILL_CONTENT_REQUIRED: a skill needs a non-empty `content` body')
    if (content.length > MAX_SKILL_CHARS) throw new Error(`SKILL_TOO_LONG: ${content.length} characters exceeds the ${MAX_SKILL_CHARS} cap; condense it to the shortcuts that actually save a wrong turn`)
    const id = matchKey(app)
    const file = join(dir, `${id}.md`)
    if (existsSync(file) && options.overwrite !== true) throw new Error(`SKILL_EXISTS: "${app}" already has a user skill at ${file}; pass overwrite:true to replace it, or use append`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, SkillStore.format({ ...input, app, content }), 'utf8')
    renameSync(tmp, file)
    this.reload()
    return this.get(id)
  }

  /**
   * Append text to one skill's body (built-in skills first materialize as a user
   * override, so the built-in file is never touched).
   * @param idOrApp - skill id or app name.
   * @param text - markdown to append.
   * @returns the updated skill.
   */
  append(idOrApp, text) {
    const skill = this.get(idOrApp)
    const extra = String(text ?? '').trim()
    if (extra.length === 0) throw new Error('SKILL_CONTENT_REQUIRED: append needs non-empty text')
    const base = skill ?? { app: String(idOrApp), content: '' }
    const merged = [base.content, extra].filter((part) => part.length > 0).join('\n')
    if (merged.length > MAX_SKILL_CHARS) throw new Error(`SKILL_TOO_LONG: appending would reach ${merged.length} characters, over the ${MAX_SKILL_CHARS} cap`)
    return this.save({ app: base.app, match: base.match, summary: base.summary, content: merged }, { overwrite: true })
  }

  /**
   * Delete one user skill. Built-ins cannot be removed, only overridden.
   * @param idOrApp - skill id or app name.
   * @returns the removed skill's app name.
   */
  remove(idOrApp) {
    this.load()
    const id = matchKey(idOrApp)
    const skill = this.skills.get(id)
    if (skill === undefined) throw new Error(`SKILL_NOT_FOUND: no skill matches "${idOrApp}"`)
    if (skill.source === 'builtin') throw new Error(`SKILL_BUILTIN: "${skill.app}" ships with the plugin and cannot be removed; save a user skill with the same app to override it`)
    const dir = this.requireUserDir()
    rmSync(join(dir, `${id}.md`), { force: true })
    this.reload()
    return skill.app
  }
}

