// 用真实 state 验证读取路径：干净值 vs 叠加值。
// 只读，不改任何东西。
import fs from 'node:fs'
import {
  deriveDrives, normalizeDrives, withJitter, withLoneliness, describeIntentState,
} from '../src/intent-engine.mjs'

const st = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
  .conversations['private:<OWNER_QQ>']
const H = 3600000
const now = Date.now()

const recent = st.recentMessages ?? []
const lastMasterAt = recent
  .filter((m) => m && !m.isSelf && Number(m.time) > 0)
  .reduce((a, m) => Math.max(a, Number(m.time)), st.lastIncomingAt || 0)

const derived = deriveDrives({
  drives: normalizeDrives(st.drives),
  drivesAt: Number(st.drivesAt) || 0,
  materials: recent.slice(-24).map((m) => ({ text: String(m?.text ?? '').slice(0, 120), time: Number(m?.time) || 0 })),
  now,
  personaBias: { connect: 0.11, care: 0.11, share: 0.11, curiosity: 0.11, play: 0.17 },
})

console.log('=== 状态层（会被存回，必须稳定）===')
console.log('  存盘的旧值:', describeIntentState(normalizeDrives(st.drives)))
console.log('  这次算出的干净值:', describeIntentState(derived.drives))

console.log('\n=== 展示层（只用于本次决策，不存）===')
console.log('  drivesAt:', st.drivesAt ? new Date(st.drivesAt).toLocaleString() : '(未设)')
console.log('  他最后说话:', lastMasterAt ? new Date(lastMasterAt).toLocaleString() : '(未知)')
console.log('  距他说话:', ((now - lastMasterAt) / H).toFixed(1), '小时')

const jittered = withJitter(derived.drives, { now })
const final = withLoneliness(jittered, lastMasterAt, now)
console.log('  抖动后:', describeIntentState(jittered))
console.log('  叠加寂寞后:', describeIntentState(final))
console.log('\n  寂寞贡献 = connect 差值:', (final.connect - jittered.connect).toFixed(4))

// 幂等验证：连算 5 次
console.log('\n=== 幂等：连算 5 次 ===')
for (let i = 0; i < 5; i += 1) {
  const d2 = deriveDrives({
    drives: normalizeDrives(st.drives), drivesAt: Number(st.drivesAt) || 0, materials: [], now, personaBias: null,
  })
  const f2 = withLoneliness(withJitter(d2.drives, { now }), lastMasterAt, now)
  console.log(`  第${i + 1}次: ${describeIntentState(f2)}`)
}
