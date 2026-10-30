// 契阔「行为轨迹」的回归（不联网、用临时库）。
// 用法：node test-covenant-facts.mjs
//
// 这里测的是**元数据**（标了几天 / 还在不在信里 / 那天改过几版），
// 不是词频 —— 词频那版实测不成立，已删（见 src/covenant-facts.mjs 顶部）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CovenantStore } from './src/covenant-store.mjs'
import { collectMarkTrail, formatMarkTrail } from './src/covenant-facts.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-'))
const DB = path.join(TMP, 'archive.db')
const KEY = 'private:1'
const NOW = new Date('2026-11-05T23:00:00+08:00').getTime()
const store = new CovenantStore(DB)

console.log('\n[1] 刚标的、还在信里 → 不产出任何话（别复述她刚做的事）')
{
  store.saveLetter({ key: KEY, day: '2026-11-05', text: '今天他说会先想着我。', marks: ['他说会先想着我'], t: NOW })
  const m = store.topMarks(KEY, 5).find((x) => x.text === '他说会先想着我')
  const trail = collectMarkTrail({ store, key: KEY, mark: m })
  check('轨迹算得出来', trail.days === 1 && trail.stillThere === true, JSON.stringify(trail))
  check('只标 1 天、还在信里 → 空串（不废话）', formatMarkTrail(trail) === '', JSON.stringify(formatMarkTrail(trail)))
}

console.log('\n[2] 连标多天 → 说出来')
{
  store.saveLetter({ key: KEY, day: '2026-11-06', text: '今天又想起，他说会先想着我。', marks: ['他说会先想着我'], t: NOW + 86400000 })
  const m = store.topMarks(KEY, 5).find((x) => x.text === '他说会先想着我')
  const trail = collectMarkTrail({ store, key: KEY, mark: m })
  check('强度涨到 2', trail.days === 2, JSON.stringify(trail))
  check('出现在 2 封信里', trail.inLetters === 2, JSON.stringify(trail))
  const line = formatMarkTrail(trail)
  check('产出「连着标了 2 天」', /连着标了 2 天/.test(line), line)
  check('产出「在 2 封信里出现过」', /2 封信/.test(line), line)
}

console.log('\n[3] 后来信里删了它 → 指出「现在的信里已经没有它了」')
{
  // ⚠ 必须用「只出现在一封信里」的标记：reverifyMarks 是拿**所有现存信**核对的，
  // 前面 11-05/11-06 的信里还留着那句话，所以那条永远算「还在」—— 这是正确行为，
  // 不是 bug（见 covenant-store.mjs 里 reverifyMarks 那段注释）。
  const K3 = 'private:3'
  const DAY = '2026-11-07'
  store.saveLetter({ key: K3, day: DAY, text: '今天很平静。不想忘的事：他给我留了糖', marks: ['他给我留了糖'], t: NOW })
  store.saveLetter({ key: K3, day: DAY, text: '今天很平静。', marks: [], t: NOW + 5000 })
  store.reverifyMarks(K3, DAY)
  const m = store.topMarks(K3, 5, { includeUnsupported: true }).find((x) => x.text === '他给我留了糖')
  const trail = collectMarkTrail({ store, key: K3, mark: m })
  check('stillThere 变 false', trail.stillThere === false, JSON.stringify(trail))
  check('产出「现在的信里已经没有它了」', /已经没有它了/.test(formatMarkTrail(trail)), formatMarkTrail(trail))
}

console.log('\n[4] 那天改过多版信 → 指出来（说明一直没想清楚）')
{
  const K2 = 'private:2'
  store.saveLetter({ key: K2, day: '2026-11-01', text: 'v1 他说会先想着我', marks: ['他说会先想着我'], t: NOW })
  store.saveLetter({ key: K2, day: '2026-11-01', text: 'v2 他说会先想着我', marks: ['他说会先想着我'], t: NOW + 1000 })
  store.saveLetter({ key: K2, day: '2026-11-01', text: 'v3 他说会先想着我', marks: ['他说会先想着我'], t: NOW + 2000 })
  const m = store.topMarks(K2, 5).find((x) => x.text === '他说会先想着我')
  const trail = collectMarkTrail({ store, key: K2, mark: m })
  check('数到 3 版', trail.versionsOnDay === 3, JSON.stringify(trail))
  check('产出「改过 3 版」', /改过 3 版/.test(formatMarkTrail(trail)), formatMarkTrail(trail))
}

console.log('\n[5] 稳健性：坏 store / 空 mark 都不抛')
{
  const ghost = collectMarkTrail({ store: null, key: KEY, mark: null })
  check('store 为 null → 返回空轨迹而不抛', ghost.days === 0 && ghost.stillThere === false, JSON.stringify(ghost))
  const brokenStore = { letters: () => { throw new Error('boom') }, letterVersions: () => [] }
  const r = collectMarkTrail({ store: brokenStore, key: KEY, mark: { strength: 3, text: 'x', firstDay: '2026-11-01', supported: true } })
  check('store 抛错 → 仍返回（且 days 已算）', r.days === 3, JSON.stringify(r))
  check('空轨迹成句是空串', formatMarkTrail(null) === '' && formatMarkTrail({ days: 1, inLetters: 1, versionsOnDay: 1, stillThere: true }) === '')
}

store.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
