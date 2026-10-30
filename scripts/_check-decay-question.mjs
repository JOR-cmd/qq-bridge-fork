// 关键问题：衰减会不会让她"不想找我"？
// 真实链路：drives 衰减 + 寂寞叠加（寂寞会随他沉默而涨）
import { deriveDrives, withLoneliness, buildIntentBlock, normalizeDrives, DEFAULT_DRIVES, topNeeds } from '../src/intent-engine.mjs'

const H = 3600000
const now = Date.now()
const base = normalizeDrives(DEFAULT_DRIVES)

console.log('场景：他们刚聊完（drives 被推高），然后他没再说话，时间流逝\n')
console.log('时间  | 衰减后的干净值                    | 叠加寂寞后                      | 会注入的建议')
console.log('------|-----------------------------------|--------------------------------|--------------')

// 起始：刚聊完，被推高
const peak = { connect: 0.42, care: 0.35, share: 0.55, curiosity: 0.30, play: 0.28 }

for (const h of [0, 4, 8, 12, 24, 36, 48]) {
  // 衰减：从 peak 出发，经过 h 小时
  const decayed = deriveDrives({
    drives: peak,
    drivesAt: now - h * H,
    now,
  }).drives
  // 寂寞：他**最后一次说话**是初始时刻（之后一直没说话）
  const withLone = withLoneliness(decayed, now - h * H, now)

  const fmt = (d) => Object.entries(d).map(([k, v]) => `${k.slice(0, 2)}${v.toFixed(2)}`).join(' ')
  const tops = topNeeds(withLone)
  const advice = tops.length ? tops.map((t) => `${t.label}${t.score.toFixed(2)}`).join('/') : '**不注入**'
  console.log(`${String(h).padStart(2)}h   | ${fmt(decayed).padEnd(33)} | ${fmt(withLone).padEnd(30)} | ${advice}`)
}

console.log('\n关键：如果她 24~48 小时没跟他说话，connect 会被寂寞推高到接近 0.7，')
console.log('     所以「不想找他」不会发生 —— 寂寞是按他沉默时长算的，越久越想找。')

// 验证极端：他一周没说话
console.log('\n=== 极端：他很久没说话时，connect 是多少 ===')
for (const h of [6, 24, 72, 168]) {
  const d = withLoneliness(base, now - h * H, now)
  console.log(`  他 ${String(h).padStart(3)}h 没说话 → connect=${d.connect.toFixed(3)}  ${d.connect >= 0.28 ? '（超过阈值，会注入"想找他"）' : ''}`)
}
