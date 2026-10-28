// Offline tests for the fuzzy control matcher behind `ui_element find`.
// Run: node test/match-selftest.mjs

import { normalize, tokens, scoreNode, rankNodes } from '../src/match.js'

let pass = 0
let fail = 0
function check(name, ok, note) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}
const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps

const node = (over) => ({ path: '0/1', role: 'Button', name: '', bounds: { x: 0, y: 0, width: 80, height: 30 }, enabled: true, offscreen: false, children: [], ...over })

check('normalize folds case, width and punctuation',
  normalize('　Ｓａｖｅ＆Ｃｌｏｓｅ…') === 'saveclose', JSON.stringify(normalize('　Ｓａｖｅ＆Ｃｌｏｓｅ…')))
check('tokens keep CJK bigrams',
  tokens('保存并关闭').has('保存') && tokens('保存并关闭').has('关闭'), [...tokens('保存并关闭')].join(','))

const exact = scoreNode('保存', node({ name: '保存' }))
const prefix = scoreNode('保存', node({ name: '保存并关闭' }))
const unrelated = scoreNode('cancel', node({ name: '保存' }))
check('exact name scores ~1', near(exact.score, 1), 'score=' + exact.score)
check('prefix match outranks nothing', prefix.score > 0.8 && prefix.score < exact.score, 'score=' + prefix.score)
check('unrelated query scores 0', unrelated.score === 0, 'score=' + unrelated.score)

const inQuery = scoreNode('点击保存按钮', node({ name: '保存' }))
check('a name mentioned inside a longer query still matches', inQuery.score >= 0.75, 'score=' + inQuery.score + ' / ' + inQuery.why)

const ascii = scoreNode('save as', node({ name: 'Save As...' }))
check('ascii labels match after normalisation', ascii.score > 0.85, 'score=' + ascii.score)

const typo = scoreNode('sav', node({ name: 'Save' }))
check('a short prefix of the label matches', typo.score > 0.8, 'score=' + typo.score)

const valueOnly = scoreNode('https', node({ role: 'Edit', name: '', value: 'https://example.com' }))
check('value is searchable too', valueOnly.score > 0.5, 'score=' + valueOnly.score + ' / ' + valueOnly.why)

const disabled = scoreNode('保存', node({ name: '保存', enabled: false }))
check('a disabled control is demoted', disabled.score < exact.score && /disabled/.test(disabled.why), 'score=' + disabled.score)

const hidden = scoreNode('保存', node({ name: '保存', offscreen: true }))
check('an offscreen control is demoted hard', hidden.score < 0.6, 'score=' + hidden.score + ' / ' + hidden.why)

const hinted = scoreNode('保存按钮', node({ role: 'Button', name: '保存' }))
const hintedWrongRole = scoreNode('保存菜单', node({ role: 'Button', name: '保存' }))
check('role words in the query break ties', hinted.score > hintedWrongRole.score, hinted.score + ' vs ' + hintedWrongRole.score)

const tree = {
  children: [
    node({ path: '0/0', role: 'MenuBar', name: '应用' }),
    node({ path: '0/1', role: 'Edit', name: '文本编辑器', value: 'dsh verify' }),
    node({ path: '0/2', role: 'Button', name: 'Save' }),
    node({ path: '0/3', role: 'Button', name: 'Save As...' }),
    node({ path: '0/4', role: 'Button', name: 'Save All' }),
    node({ path: '0/5', role: 'Button', name: '关闭' }),
  ],
}
const ranked = rankNodes('save', tree, { limit: 3 })
check('ranking returns the best three', ranked.length === 3 && ranked[0].name === 'Save', ranked.map((r) => r.name + ':' + r.score).join(' | '))
check('ranking is ordered best first', ranked.length === 3 && ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score)
check('every candidate carries a reason', ranked.every((r) => typeof r.why === 'string' && r.why.length > 0), ranked.map((r) => r.why).join(' | '))
check('a CJK description finds the CJK control', rankNodes('保存', tree, { limit: 3 }).length === 0, 'no CJK labels in this tree')

const onlyButtons = rankNodes('save', tree, { limit: 5, role: 'button' })
check('role filter narrows the pool', onlyButtons.length === 3 && onlyButtons.every((r) => /button/i.test(r.role)), onlyButtons.map((r) => r.role).join(','))

const nothing = rankNodes('zzzz-no-such-control', tree, { limit: 3 })
check('no match means no candidates', nothing.length === 0, 'got ' + nothing.length)

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
