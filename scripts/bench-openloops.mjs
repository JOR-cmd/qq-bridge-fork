// 实测 collectOpenLoops 的真实开销（含不同消息量）。
import { collectOpenLoops } from '../src/intent-engine.mjs'

const now = Date.now()

function makeMessages(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    // 混合：提问 / 陈述 / 噪声，尽量接近真实
    const kinds = ['这个弄好了没？', '嗯', '今天好累', '草', '[图片]', '明天要考试了，得早点睡']
    const text = kinds[i % kinds.length]
    out.push({ text, plain: text, isSelf: i % 2 === 0, time: now - (n - i) * 60000 })
  }
  return out
}

console.log('消息数 | 耗时(ms) | 备注')
console.log('-------|----------|------')
for (const n of [50, 100, 200, 400, 800]) {
  const msgs = makeMessages(n)
  // 预热一次（JIT）
  collectOpenLoops({ messages: msgs.slice(-100), now })

  const rounds = 20
  const t0 = process.hrtime.bigint()
  for (let r = 0; r < rounds; r += 1) collectOpenLoops({ messages: msgs, now })
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6 / rounds
  console.log(`${String(n).padStart(6)} | ${ms.toFixed(3).padStart(8)} | `)
}

console.log('\n注：bridge 调用时传的是 recentMessages（上限 200 条），所以实际看 200 那一行。')
