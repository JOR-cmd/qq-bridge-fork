// 用真实 state/ 跑一遍收尾判断（只读，不发消息、不写盘）。
// 用法：node scripts/preview-closure.mjs [key]
import fs from 'node:fs'
import {
  assessConversationClosure, closurePromptBlock,
  normalizeClosureConfig, closeGate,
} from '../src/closure-engine.mjs'

const social = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'))
const key = process.argv[2] || Object.keys(social.conversations)[0]
const st = social.conversations[key]

console.log(`会话：${key}\n`)
const now = Date.now()

const a = assessConversationClosure({
  key,
  kind: key.startsWith('private:') ? 'private' : 'group',
  messages: st.recentMessages,
  unread: st.unread,
  now,
  activeTopics: st.activeTopics,
  pendingThoughts: st.pendingThoughts,
  config: normalizeClosureConfig({}),
})

console.log(`判断：${a.verdict}（score ${a.score}）`)
console.log(`建议：${a.advice}`)
console.log(`原因：${a.reasons.join('；')}`)
console.log(`\n信号：`)
for (const [k, v] of Object.entries(a.signals)) {
  if (v === null) continue
  console.log(`  ${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`)
}

const gate = closeGate(a)
console.log(`\n硬闸：${gate.blocked ? `拦住了（${gate.reason}）` : '放行'}`)
if (gate.blocked) console.log(`  ${gate.error}`)

console.log('\n================ 会注入提示词的段落 ================')
const block = build(st)
console.log(block || '（空 —— 没有近期对话，不注入）')
console.log('====================================================')
console.log(`字数 ${[...block].length}`)

// 上一次收尾记录
if (st.closure) {
  console.log('\n上次收尾记录：')
  console.log('  ', JSON.stringify(st.closure, null, 2).split('\n').join('\n   '))
} else {
  console.log('\n（还没有收尾记录）')
}

function build(state) {
  return closurePromptBlock(a, { record: state.closure ?? null, now, config: normalizeClosureConfig({}) })
}
