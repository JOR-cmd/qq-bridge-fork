// 验证「被惦记 N 次之后降权」是否真的生效（只读 state/）。
import fs from 'node:fs'
import { collectOpenLoops } from '../src/intent-engine.mjs'

const st = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
  .conversations['private:<OWNER_QQ>']

const now = Date.now()
const KEY = '不行，明天交了'

console.log('同一件事被惦记 N 次之后的权重：')
for (const n of [0, 1, 2, 3, 4, 6]) {
  const seenLoops = { [KEY]: { count: n, lastAt: now - 2 * 3600 * 1000 } }
  const loops = collectOpenLoops({ messages: st.recentMessages, now, seenLoops })
  const hit = loops.find((l) => l.text === KEY)
  if (hit) {
    console.log(`  count=${n}: 权重 ${hit.weight.toFixed(2)}（降权 ${(hit.familiarity * 100).toFixed(0)}%）`)
  } else {
    console.log(`  count=${n}: 已过滤（不再提）`)
  }
}

console.log('\n隔一天之后（lastAt 是 25 小时前）应该回升一些：')
for (const n of [2, 4]) {
  const seenLoops = { [KEY]: { count: n, lastAt: now - 25 * 3600 * 1000 } }
  const loops = collectOpenLoops({ messages: st.recentMessages, now, seenLoops })
  const hit = loops.find((l) => l.text === KEY)
  console.log(`  count=${n}: ${hit ? `权重 ${hit.weight.toFixed(2)}` : '已过滤'}`)
}
