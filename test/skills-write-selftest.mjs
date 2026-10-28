/** Writable-skill tests: save / append / remove against a throwaway user dir. */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillStore } from '../src/skills.js'
import { createAppSkillTool } from '../src/tools.js'

const userDir = mkdtempSync(join(tmpdir(), 'dsh-cu-skills-'))
const store = new SkillStore({ userDir })
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? '  [' + detail + ']' : ''}`) }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? '  [' + detail + ']' : ''}`) }
}
const throwsWith = (name, fn, code) => {
  try { fn(); check(name, false, 'no throw') } catch (cause) { check(name, String(cause?.message).includes(code), String(cause?.message).slice(0, 70)) }
}

try {
  const saved = store.save({ app: 'Notion', match: ['Notion.exe'], summary: '快速记一笔', content: '- ctrl+n 新建页面' })
  check('save writes a user skill', existsSync(saved.path) && saved.source === 'user', saved.path.split(/[\\/]/).pop())
  check('front matter is canonical', readFileSync(saved.path, 'utf8').startsWith('---\napp: Notion\nmatch: Notion.exe\nsummary: 快速记一笔\n---'))
  check('reload makes it findable', store.find(['NOTION.EXE'])?.app === 'Notion')

  throwsWith('duplicate save is rejected', () => store.save({ app: 'Notion', content: '- x' }), 'SKILL_EXISTS')
  const overwritten = store.save({ app: 'Notion', content: '- ctrl+p 搜索' }, { overwrite: true })
  check('overwrite replaces the body', overwritten.content.includes('ctrl+p'), `${overwritten.chars} chars`)

  const before = readFileSync(overwritten.path, 'utf8')
  throwsWith('over-long body is rejected', () => store.save({ app: 'Notion', content: 'x'.repeat(5000) }, { overwrite: true }), 'SKILL_TOO_LONG')
  check('rejected write left the file untouched', readFileSync(overwritten.path, 'utf8') === before)

  const appended = store.append('Notion', '- ctrl+shift+n 新建窗口')
  check('append keeps old and new text', appended.content.includes('ctrl+p') && appended.content.includes('ctrl+shift+n'), `${appended.chars} chars`)

  const userExcel = store.save({ app: 'Excel', content: '- 名称框直接输 B3' }, { overwrite: true })
  check('user skill overrides a built-in', userExcel.source === 'user' && store.get('excel').source === 'user')
  throwsWith('built-in cannot be removed', () => store.remove('word'), 'SKILL_BUILTIN')
  check('user skill can be removed', store.remove('Notion') === 'Notion' && !existsSync(saved.path))

  const calls = []
  const runtime = {
    config: {},
    lastView: null,
    skillStore: store,
    skillCatalog: () => store.catalog(),
    skillFor: (names) => store.find(names),
    beforeMutation: async () => ({ dryRun: false }),
    call: async (cmd) => { calls.push(cmd); return {} },
  }
  const tool = createAppSkillTool(runtime, {})
  const okValue = await tool.execute({ action: 'save', app: 'Slack', content: '- ctrl+k 快速切换' }, {})
  check('tool action save writes', okValue.found === true && okValue.chars > 0, okValue.app)
  const dryRuntime = { ...runtime, beforeMutation: async () => ({ dryRun: true }) }
  const dryValue = await createAppSkillTool(dryRuntime, {}).execute({ action: 'save', app: 'DryRunOnly', content: '- x' }, {})
  check('dry run does not write', dryValue.dryRun === true && !existsSync(join(userDir, 'dryrunonly.md')))
  const listValue = await tool.execute({ action: 'list' }, {})
  check('tool action list sees user skills', listValue.count >= 1 && listValue.skills.includes('Slack'))
  check('schema exposes the write actions', tool.parameters.properties.action.enum.join(',') === 'list,get,save,append,remove')
} finally {
  rmSync(userDir, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

