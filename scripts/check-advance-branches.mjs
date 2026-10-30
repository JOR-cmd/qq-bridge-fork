// 验证 advanceDrivesV2 修复后的完整行为（纯逻辑模拟，不碰真实 state）。
import { deriveDrives, normalizeDrives, DEFAULT_DRIVES } from '../src/intent-engine.mjs'

const H = 3600000
const now = Date.now()
const fmt = (d) => JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, +v.toFixed(3)])))

// 模拟 st（线上真实状态）
const st = {
  drives: { connect: 0.427, care: 0.336, share: 0.489, curiosity: 0.256, play: 0.295 },
  drivesAt: now - 5.5 * H,
  intentNextDrives: undefined,
}

console.log('=== 模拟 advanceDrivesV2 的两条分支 ===\n')

// 分支 A：没有 intentNextDrives（她正常对话，没被主动机会唤醒）
console.log('分支 A：正常对话（没跑 intent）')
const before = normalizeDrives(st.drives)
const afterA = deriveDrives({ drives: before, drivesAt: st.drivesAt, now }).drives
console.log('  推进前:', fmt(before))
console.log('  推进后:', fmt(afterA))
const movedA = Object.keys(DEFAULT_DRIVES).filter((k) => Math.abs(afterA[k] - before[k]) > 0.01)
console.log(`  ${movedA.length ? '✓' : '✗'} 衰减生效（${movedA.join(', ')}）`)

// 分支 B：有 intentNextDrives（她刚被主动机会唤醒）
console.log('\n分支 B：被主动机会唤醒（跑过 intent）')
const intentResult = deriveDrives({
  drives: before,
  drivesAt: st.drivesAt,
  materials: [{ text: '今天好累', time: now - 2 * H }],
  now,
})
const afterB = normalizeDrives(intentResult.drives)
console.log('  推进后（含素材加成）:', fmt(afterB))
const changedB = Object.keys(DEFAULT_DRIVES).some((k) => Math.abs(afterB[k] - before[k]) > 0.01)
console.log(`  ${changedB ? '✓' : '✗'} 变化生效`)

// 关键：两条分支都不该让值涨到 1
console.log('\n=== 关键检查：不该有任何维度接近 1 ===')
const nearOne = Object.entries(afterA).filter(([, v]) => v > 0.8)
console.log(`  分支 A 超 0.8 的维度: ${nearOne.length ? nearOne.map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ') : '无 ✓'}`)

// 幂等：连续推进 10 次
console.log('\n=== 幂等：连聊 10 轮后不该累积到封顶 ===')
let d = before
let at = st.drivesAt
for (let i = 0; i < 10; i += 1) {
  const t = now + i * 60000
  const r = deriveDrives({ drives: d, drivesAt: at, now: t })
  d = r.drives
  at = t
}
console.log(`  10 轮后: ${fmt(d)}`)
const ok = Object.values(d).every((v) => v < 0.8)
console.log(`  ${ok ? '✓ 没累积到封顶' : '✗ 又累积了'}`)

// 寂寞叠加（读取层）
console.log('\n=== 寂寞叠加（读取层，不写状态）===')
const { withLoneliness } = await import('../src/intent-engine.mjs')
for (const h of [1, 12, 24]) {
  const w = withLoneliness(afterA, now - h * H, now)
  console.log(`  他 ${String(h).padStart(2)}h 没说话 → connect=${w.connect.toFixed(3)}`)
}
