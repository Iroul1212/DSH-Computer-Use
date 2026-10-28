import { WinHost } from '../src/win/backend.mjs'
const h = new WinHost({ log: () => {} })
await h.start()
const start = await h.call('cursor', {})
for (const [x, y] of [[100, 100], [1280, 800], [2400, 1500], [2021, 1156], [2558, 890]]) {
  const r = await h.call('move', { x, y, durationMs: 30 })
  const c = await h.call('cursor', {})
  console.log('target ' + x + ',' + y + ' -> cursor ' + c.x + ',' + c.y + '   dx=' + (c.x - x) + ' dy=' + (c.y - y) + '  (move said ' + r.x + ',' + r.y + ')')
}
await h.call('move', { x: start.x, y: start.y, durationMs: 30 })
const back = await h.call('cursor', {})
console.log('restored ' + back.x + ',' + back.y + ' (was ' + start.x + ',' + start.y + ')')
await h.close()

