// 验证「同一唤醒里 buildIntentLineV2 被调用两次」会不会把驱动值推高两次。
// 只读、不写真实 state。
import fs from 'node:fs'
import { deriveDrives, normalizeDrives } from '../src/intent-engine.mjs'

const st = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
  .conversations['private:<OWNER_QQ>']

const recent = st.recentMessages
const materials = recent.slice(-24).map((m) => ({ text: String(m?.text ?? '').slice(0, 120) }))
const lastMasterAt = recent.filter((m) => m && !m.isSelf).reduce((a, m) => Math.max(a, Number(m.time) || 0), 0)
const personaBias = { connect: 0.11, care: 0.11, share: 0.11, curiosity: 0.11, play: 0.17 }
const noJitter = () => 0.5

console.log('模拟「一次唤醒里调用两次」：\n')

let drives = normalizeDrives(st.drives)
let drivesAt = Number(st.drivesAt) || 0
const now = Date.now()

for (let i = 1; i <= 3; i += 1) {
  const d = deriveDrives({ drives, drivesAt, materials, now, lastMasterAt, personaBias, random: noJitter })
  drives = d.drives
  drivesAt = d.drivesAt
  console.log(`第 ${i} 次: share=${drives.share.toFixed(3)} connect=${drives.connect.toFixed(3)} care=${drives.care.toFixed(3)}`)
}

console.log('\n如果每次都用**原始** drives（正确做法，drivesAt 不重置）：')
let d2 = normalizeDrives(st.drives)
const at2 = Number(st.drivesAt) || 0
for (let i = 1; i <= 3; i += 1) {
  const r = deriveDrives({ drives: d2, drivesAt: at2, materials, now, lastMasterAt, personaBias, random: noJitter })
  // 不写回 drivesAt，模拟"只是读一次、不推进状态"
  console.log(`第 ${i} 次: share=${r.drives.share.toFixed(3)} connect=${r.drives.connect.toFixed(3)} care=${r.drives.care.toFixed(3)}`)
}
