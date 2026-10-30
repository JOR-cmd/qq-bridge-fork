// 验证：衰减不再依赖 buildIntentLineV2（proactiveCheck 才跑）。
import fs from 'node:fs'
import { deriveDrives, normalizeDrives } from '../src/intent-engine.mjs'

const H = 3600000
const now = Date.now()

// 模拟：drivesAt 是 4.5 小时前（线上真实状态），这轮她只是正常回复（没跑 intent）
const st = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
  .conversations['private:<OWNER_QQ>']

console.log('=== 线上真实状态 ===')
console.log('drivesAt:', new Date(st.drivesAt).toLocaleString(), `(${((now - st.drivesAt) / H).toFixed(1)} 小时前)`)
console.log('drives:', JSON.stringify(st.drives))

console.log('\n=== 修正后的行为：没有 intentNextDrives 也要推进 ===')
const before = normalizeDrives(st.drives)
const after = deriveDrives({ drives: before, drivesAt: st.drivesAt, now })
console.log('推进前:', JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, +v.toFixed(3)]))))
console.log('推进后:', JSON.stringify(Object.fromEntries(Object.entries(after.drives).map(([k, v]) => [k, +v.toFixed(3)]))))
console.log('（应明显向基线回落 —— 4.5 小时 = 0.56 个半衰期）')

const base = { connect: 0.30, care: 0.22, share: 0.18, curiosity: 0.15, play: 0.10 }
console.log('\n基线:', JSON.stringify(base))
const moved = Object.keys(base).filter((k) => Math.abs(after.drives[k] - before[k]) > 0.01)
console.log('发生回落的维度:', moved.join(', ') || '(无 —— 说明没推进)')

// 关键断言
const ok = moved.length > 0 && moved.every((k) => Math.abs(after.drives[k] - base[k]) <= Math.abs(before[k] - base[k]))
console.log()
console.log(ok ? '✓ 衰减生效：都在向基线回落' : '✗ 衰减没生效')
process.exit(ok ? 0 : 1)
