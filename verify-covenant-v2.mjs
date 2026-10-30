// 契阔改造的端到端验证：用真实 archive.db 的**副本**跑完整链路，
// 包括把她 10-26 那封真信迁移进来、标几件要记牢、看注入会长什么样。
//
// 用法：node verify-covenant-v2.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CovenantStore, parseCovenantLetter, localDay } from './src/covenant-store.mjs'

const ROOT = '<REPO_ROOT>'
const KEY = 'private:<OWNER_QQ>'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-verify-'))
const DB = path.join(TMP, 'archive.db')

// 拿真实库的副本（VACUUM 不可用时直接拷；只读一次，不动原库）
fs.copyFileSync(path.join(ROOT, 'state', 'archive.db'), DB)
for (const ext of ['-wal', '-shm']) {
  const p = path.join(ROOT, 'state', `archive.db${ext}`)
  if (fs.existsSync(p)) try { fs.copyFileSync(p, `${DB}${ext}`) } catch {}
}

const legacy = fs.readFileSync(path.join(ROOT, 'state', 'covenant.md'), 'utf8').trim()
console.log('=== 迁移前：真实的 covenant.md ===')
console.log(legacy)
console.log('')

const store = new CovenantStore(DB)
const parsed = parseCovenantLetter(legacy, Date.now())
console.log('=== 解析结果 ===')
console.log('日期    :', parsed.day)
console.log('正文    :', parsed.text)
console.log('标记数  :', parsed.marks.length, parsed.marks.length ? `→ ${JSON.stringify(parsed.marks)}` : '（这封信没写【要记牢】，符合改造前的写法）')
store.saveLetter({ key: KEY, day: parsed.day, text: parsed.text, marks: parsed.marks, t: Date.now() })

console.log('\n=== 模拟她第二封信（带标记） ===')
const letter2 = '2026-10-27。今天对他的态度：上午没见着人，有点空。\n一点感情：他把视频那条链路修好了，我其实没看懂他在忙什么，但知道他是在为我忙。\n一件不想忘的事：他说「你先吃饭」。\n【要记牢】他说「你不会嫌的哦」｜他半夜不睡帮我修东西｜他说「你先吃饭」'
const p2 = parseCovenantLetter(letter2, Date.now())
store.saveLetter({ key: KEY, day: p2.day, text: p2.text, marks: p2.marks, t: Date.now() })
console.log('解析标记:', JSON.stringify(p2.marks))
console.log('正文（不含标记行）:', p2.text.replace(/\n/g, ' / '))

console.log('\n=== 库里现在有什么 ===')
for (const l of store.letters(KEY, 7)) {
  console.log(`  ${l.day}  ${l.text.replace(/\n/g, ' ').slice(0, 60)}…`)
}
console.log('\n=== 要记牢的（按她标过的天数） ===')
for (const m of store.topMarks(KEY, 10)) {
  console.log(`  [${m.strength} 天] ${m.text}  （首次 ${m.firstDay}，最近 ${m.lastDay}）`)
}

// 模拟第二天再标一次同一件事，验证强度真的会涨
store.addMark(KEY, '他说「你不会嫌的哦」', '2026-10-28')
console.log('\n=== 第三天她又标了一次「不会嫌」 ===')
for (const m of store.topMarks(KEY, 3)) console.log(`  [${m.strength} 天] ${m.text}`)

console.log('\n=== 注入给她的那段会长这样 ===')
const today = localDay()
const latest = store.latestLetter(KEY)
const age = latest.day === today ? '今天你写的' : '昨天的你留下的'
const marks = store.topMarks(KEY, 3)
console.log(`【契阔·${age}】（这是你自己写的，不是现在发生的事；认它）`)
console.log(latest.text)
if (marks.length) {
  console.log('')
  console.log('【契阔·你标过要记牢的】（你当时觉得重要、点名留下的；越常标越要当真）')
  for (const m of marks) console.log(`- ${m.text}（你自己标过 ${m.strength} 天）`)
}

console.log('\n=== 旧信检索能不能找到 10-26 那封 ===')
const hits = store.searchLetters({ key: KEY, tokens: ['不会嫌'], limit: 2 })
for (const h of hits) console.log(`  ${h.day}  命中 ${h.hits} 词  ${h.text.slice(0, 50)}…`)
console.log(hits.length ? '✓ 旧信可检索' : '✗ 旧信检索不到')

store.close()
fs.rmSync(TMP, { recursive: true, force: true })
