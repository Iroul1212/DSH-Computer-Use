/**
 * Fuzzy matching for `ui_element find`.
 *
 * A model rarely knows a control's exact accessibility name: it knows what the
 * button *says* or roughly what it does ("保存", "Save as", "the search box").
 * This module turns that into a ranked shortlist with a human-readable reason,
 * so the agent can pick a candidate instead of guessing a pixel.
 *
 * Everything here is a pure function over plain objects: no I/O, no host calls,
 * so the scoring can be unit-tested without a desktop.
 * @module dsh-computer-use/match
 */

/** Roles a user can actually act on; used as a small tie-breaker bonus. */
const ACTIONABLE_ROLES = new Set([
  'button', 'splitbutton', 'menuitem', 'checkbox', 'radiobutton', 'combobox',
  'edit', 'listitem', 'tabitem', 'hyperlink', 'treeitem', 'slider', 'spinner',
])

/** Query words that name a control kind, mapped onto the role they imply. */
const ROLE_HINTS = [
  { words: ['按钮', 'button', 'btn'], role: 'button' },
  { words: ['菜单', 'menu'], role: 'menuitem' },
  { words: ['输入框', '文本框', 'edit', 'textbox', 'text box'], role: 'edit' },
  { words: ['下拉', 'combo', 'dropdown'], role: 'combobox' },
  { words: ['标签页', 'tab'], role: 'tabitem' },
  { words: ['复选框', '勾选', 'checkbox'], role: 'checkbox' },
  { words: ['列表', 'list'], role: 'listitem' },
  { words: ['链接', 'link'], role: 'hyperlink' },
]

/**
 * Fold a label into the form the comparison uses: lower case, NFKC (so full-width
 * letters and digits compare equal), no punctuation or symbols, single spaces.
 * @param value - anything with a toString.
 * @returns the normalised string, or '' for empty input.
 */
export function normalize(value) {
  if (value === null || value === undefined) return ''
  let text = String(value).normalize('NFKC').toLowerCase()
  text = text.replace(/&/g, '').replace(/[\p{P}\p{S}]+/gu, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Split a normalised string into words. CJK runs have no spaces, so each run of
 * length > 1 also contributes its bigrams - that is what lets "保存" match
 * inside "保存并关闭" without a dictionary.
 * @param text - already normalised text.
 * @returns a set of tokens.
 */
export function tokens(text) {
  const out = new Set()
  for (const word of String(text || '').split(/\s+/)) {
    if (!word) continue
    out.add(word)
    const cjk = word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []
    for (const run of cjk) {
      if (run.length <= 2) { out.add(run); continue }
      for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
    }
  }
  return out
}

/** Jaccard similarity of two token sets, 0..1. */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * How much of `query` appears inside `text` in order, 0..1. Catches typos in the
 * middle of a label ("svae" vs "save") cheaply.
 */
function subsequenceCoverage(query, text) {
  if (!query || !text) return 0
  let i = 0
  for (const ch of text) {
    if (ch === query[i]) i += 1
    if (i === query.length) break
  }
  return i / query.length
}

/** Role implied by the words of the query, or null. */
function roleHintOf(query) {
  for (const hint of ROLE_HINTS) {
    if (hint.words.some((word) => query.includes(word))) return hint.role
  }
  return null
}

/**
 * Score one UI Automation node against a free-text description.
 * @param query - what the model is looking for, e.g. "保存按钮".
 * @param node - a node from the host's `uia` tree.
 * @returns `{score: number, why: string}`; score is 0 when nothing matched.
 */
export function scoreNode(query, node) {
  const q = normalize(query)
  if (!q || !node) return { score: 0, why: '' }
  const qTokens = tokens(q)
  const hint = roleHintOf(q)

  const fields = [
    { text: node.name, weight: 1, label: 'name' },
    { text: node.automationId, weight: 0.85, label: 'automationId' },
    { text: node.helpText, weight: 0.7, label: 'help text' },
    { text: node.value, weight: 0.65, label: 'value' },
    { text: node.role, weight: 0.5, label: 'role' },
  ]

  let best = 0
  let why = ''
  for (const field of fields) {
    const text = normalize(field.text)
    if (!text) continue
    let raw = 0
    let reason = ''
    if (text === q) {
      raw = 1
      reason = `${field.label} is exactly the query`
    } else if (text.startsWith(q)) {
      raw = 0.94
      reason = `${field.label} starts with the query`
    } else if (text.includes(q)) {
      raw = 0.9
      reason = `${field.label} contains the query`
    } else if (q.includes(text) && text.length >= 2) {
      raw = 0.82
      reason = `the query names this ${field.label}`
    } else {
      const j = jaccard(qTokens, tokens(text))
      if (j >= 0.34) {
        raw = 0.2 + j * 0.6
        reason = `${Math.round(j * 100)}% of the words match the ${field.label}`
      } else {
        const sub = subsequenceCoverage(q.replace(/\s+/g, ''), text.replace(/\s+/g, ''))
        if (sub >= 0.7) {
          raw = 0.15 + sub * 0.45
          reason = `the query appears in order inside the ${field.label}`
        }
      }
    }
    const weighted = raw * field.weight
    if (weighted > best) {
      best = weighted
      why = reason
    }
  }

  if (best === 0) return { score: 0, why: '' }

  const role = normalize(node.role)
  if (hint && role === hint) {
    best *= 1.1
    why += ` (and its role is ${node.role})`
  } else if (hint && !role.includes(hint)) {
    best *= 0.8
  }
  if (node.enabled === false) {
    best *= 0.75
    why += ' - disabled'
  }
  if (node.offscreen === true) {
    best *= 0.45
    why += ' - scrolled out of view'
  }
  const b = node.bounds
  if (b && (b.width < 4 || b.height < 4)) best *= 0.5
  if (ACTIONABLE_ROLES.has(role)) best *= 1.05

  return { score: Math.round(Math.min(1, best) * 100) / 100, why }
}

/**
 * Rank every node in a UI Automation tree against a description.
 * @param query - free-text description.
 * @param root - root node of the host's `uia` tree.
 * @param options - `{limit, role}`; role is a substring filter like "button".
 * @returns up to `limit` candidates, best first, each carrying `score` and `why`.
 */
export function rankNodes(query, root, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit ?? 3)))
  const roleNeedle = normalize(options.role)
  const found = []
  const walk = (node) => {
    if (!node) return
    const role = String(node.role ?? '')
    const roleOk = !roleNeedle || normalize(role).includes(roleNeedle)
    if (roleOk) {
      const { score, why } = scoreNode(query, node)
      if (score > 0.05) {
        found.push({
          path: node.path,
          role,
          name: String(node.name ?? ''),
          value: node.value === null || node.value === undefined ? null : String(node.value),
          automationId: node.automationId ? String(node.automationId) : null,
          bounds: node.bounds ?? null,
          enabled: node.enabled !== false,
          offscreen: node.offscreen === true,
          score,
          why,
        })
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  found.sort((a, b) => b.score - a.score || String(a.name).length - String(b.name).length)
  return found.slice(0, limit)
}
