import { writeFileSync } from 'node:fs'
import { WinHost } from '../src/win/backend.mjs'
const h = new WinHost({ log: () => {} })
await h.start()
const shot = await h.call('screenshot', { grid: true, mark: { x: 200, y: 150 }, maxWidth: 900, format: 'png' })
writeFileSync('test/out/grid.png', Buffer.from(shot.image.base64, 'base64'))
console.log('decorated=' + shot.decorated + ' change=' + JSON.stringify(shot.change) + ' size=' + shot.image.width + 'x' + shot.image.height)
await h.close()
