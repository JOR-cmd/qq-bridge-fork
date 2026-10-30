// 验证修复后：同一回合的两次 buildIntentLineV2 会得到一致的结果。
// 只读真实 state，不改任何东西。
import fs from 'node:fs'
import { deriveDrives, normalizeDrives, describeIntentState } from '../src/intent-engine.mjs'

const st = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
  .conversations['private:<OWNER_QQ>']

const materials = (st.recentMessages ?? []).slice(-24).map((m) => ({
  text: String(m?.text ?? '').slice(0, 120),
  time: Number(m?.time) || 0,
}))
const lastMasterAt = (st.recentMessages ?? [])
  .filter((m) => m && !m.isSelf)
  .reduce((a, m) => Math.max(a, Number(m.time) || 0), 0)
const personaBias = { connect: 0.11, care: 0.11, share: 0.11, curiosity: 0.11, play: 0.17 }

const args = {
  drives: normalizeDrives(st.drives),
  drivesAt: Number(st.drivesAt) || 0,
  materials,
  now: Date.now(),
  lastMasterAt,
  personaBias,
}

console.log('模拟同一回合里的两次调用（唤醒提示 + 会话提示）：\n')
console.log('第一次:', describeIntentState(deriveDrives(args).drives))
console.log('第二次:', describeIntentState(deriveDrives(args).drives))
console.log('第三次:', describeIntentState(deriveDrives(args).drives))

const a = deriveDrives(args).drives
const b = deriveDrives(args).drives
const same = ['connect', 'care', 'share', 'curiosity', 'play'].every((k) => Math.abs(a[k] - b[k]) < 1e-12)
console.log(`\n${same ? '✓ 一致 —— 重复调用不再推高' : '✗ 不一致 —— 还有累积问题'}`)

console.log('\n当前落盘状态：')
console.log('  drives:', describeIntentState(normalizeDrives(st.drives)))
console.log('  drivesAt:', st.drivesAt ? new Date(st.drivesAt).toLocaleString() : '(未设)')
