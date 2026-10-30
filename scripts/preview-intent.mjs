// 用真实 state/social-v2.json 跑一遍目的引擎（只读，不写盘、不发消息）。
// 用法：node scripts/preview-intent.mjs [key]
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveDrives, collectOpenLoops, buildIntentBlock, analyzePersonaBias,
  DEFAULT_DRIVES, normalizeDrives, describeIntentState, topNeeds,
} from '../src/intent-engine.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const STATE = path.join(ROOT, 'state')

const social = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'))
const key = process.argv[2] || Object.keys(social.conversations)[0]
const st = social.conversations[key]

console.log(`会话：${key}\n`)

// 人格卡
const roleState = JSON.parse(fs.readFileSync(path.join(STATE, 'current-role.json'), 'utf8'))
const rolePath = path.join(ROOT, 'roles', `${roleState.role}.md`)
const personaText = fs.existsSync(rolePath) ? fs.readFileSync(rolePath, 'utf8') : ''
const persona = analyzePersonaBias(personaText)
console.log(`人格卡：${roleState.role}（${[...personaText].length} 字符）`)
console.log(`动机先验：${persona.traits.map((t) => `${t.label}(${t.hits}词/${t.bias.toFixed(2)})`).join(' ') || '无'}\n`)

const recent = Array.isArray(st.recentMessages) ? st.recentMessages : []
const lastMasterAt = recent.filter((m) => m && !m.isSelf && Number(m.time) > 0)
  .reduce((max, m) => Math.max(max, Number(m.time)), st.lastIncomingAt || 0)

const now = Date.now()
const derived = deriveDrives({
  drives: normalizeDrives(st.drives),
  drivesAt: Number(st.drivesAt) || 0,
  materials: recent.slice(-24).map((m) => ({ text: String(m.text ?? '').slice(0, 120) })),
  now,
  lastMasterAt,
  personaBias: persona.bias,
})

console.log(`需求向量：${describeIntentState(derived.drives)}`)
console.log(`最强倾向：${topNeeds(derived.drives).map((t) => `${t.label} ${t.score.toFixed(2)}`).join(' / ') || '（都低于阈值）'}\n`)

const loops = collectOpenLoops({ messages: recent, now, seenLoops: st.intentSeen || {} })
console.log(`惦记的事（${loops.length} 件）：`)
for (const l of loops) {
  const age = l.ageMs / 3600000
  const fam = l.familiarity ? `，已提过${Math.round(l.familiarity * 100)}%权重` : ''
  console.log(`  [${l.owner}/${l.kind}] ${l.text}  （${age.toFixed(1)}h 前，权重 ${l.weight.toFixed(2)}${fam}，${l.why}）`)
}

if (st.intentSeen && Object.keys(st.intentSeen).length) {
  console.log('\n已被提过的事（降权记录）：')
  for (const [k, v] of Object.entries(st.intentSeen)) {
    console.log(`  ${k.slice(0, 30)} → 提过 ${v.count} 次，最后 ${new Date(v.lastAt).toLocaleString()}`)
  }
}

console.log('\n================ 会注入提示词的段落 ================')
const block = buildIntentBlock({ drives: derived.drives, loops, now, personaTraits: persona.traits })
console.log(block || '（空 —— 没有足够素材，不产出）')
console.log('====================================================')
console.log(`字数 ${[...block].length}`)
