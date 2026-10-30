// 一次性修数据：把「归一化后指向同一件事」的重复标记合并。
//
// 为什么需要：2026-10-28 之前的 normalizeMarkText 先剥前缀再剥引号，导致
// 「他说「你是我最爱的鱼鱼」」和「他说你是我最爱的鱼鱼」算成两个 norm，
// 同一件事在强度榜上出现两次。现在归一化改成「先剥引号再剥前缀」，就露出来了。
//
// 做法：按 new norm 分组 → 每组留最早那行、把强度取各行的最大值（取 max 而不是相加：
// 同一件事被重复记录不该让强度翻倍，那是它自己的 bug 造成的，不该赏给它），
// 其余行删除；删除前打印出来。**默认 dry-run，加 --apply 才真的写。**
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeMarkText } from '../src/covenant-store.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const dbArgIdx = process.argv.indexOf('--db')
const DB = dbArgIdx > 0 && process.argv[dbArgIdx + 1]
  ? path.resolve(process.argv[dbArgIdx + 1])
  : path.join(ROOT, 'state', 'archive.db')
const apply = process.argv.includes('--apply')
console.log(`库: ${DB}`)

const db = new DatabaseSync(DB)
const rows = db.prepare(
  'SELECT id,key,norm,text,strength,firstDay,lastDay,supported,missCount,retiredAt FROM covenant_marks ORDER BY id',
).all()

const groups = new Map()
// ⚠ 已退役的行**不参与合并**。
// 退役行带着她的 why / pred / 回访结论（那是「只加不改」的账本）；
// 如果让它和一条现同行归一化后同组，脚本会"留下 id 最小的、删掉另一条" ——
// 很可能把整段退役记录删掉。所以退役行单独一组（加上 id 保证不会与现同行同组），
// 只校正它自己的 norm。
for (const r of rows) {
  const live = r.retiredAt == null
  const k = `${r.key}\u0000${live ? normalizeMarkText(r.text) : `RETIRED\u0000${r.id}`}`
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}

let merged = 0
const touch = db.prepare('UPDATE covenant_marks SET norm=?, strength=?, lastDay=? WHERE id=?')
const drop = db.prepare('DELETE FROM covenant_marks WHERE id=?')

db.exec('BEGIN')
try {
  for (const [k, list] of groups) {
    if (list.length < 2) {
      // 单条也顺手把 norm 校正成新口径（否则下次归一化又会分叉）
      const r = list[0]
      const want = normalizeMarkText(r.text)
      if (r.norm !== want) {
        // ⚠ 改 norm 前必须确认目标 norm 没被**别的行**占着 —— 否则撞 UNIQUE(key,norm)。
        // 这正是实测踩到的：一条退役行（norm 是旧口径）要和一条现同行对齐时，
        // 现同行已经占着那个 norm。撞上就跳过：留着旧 norm 不影响正确性，
        // 只是这条以后不会再和同义行合并（下次跑脚本还能再看一遍）。
        const holder = db.prepare('SELECT id FROM covenant_marks WHERE key=? AND norm=? AND id<>?').get(r.key, want, r.id)
        if (holder) {
          console.log(`  跳过 norm 校正（会被 id=${holder.id} 占用）: 「${r.text}」`)
          continue
        }
        console.log(`  改 norm: ${JSON.stringify(r.norm)} → ${JSON.stringify(want)}`)
        if (apply) touch.run(want, Number(r.strength), String(r.lastDay), r.id)
      }
      continue
    }
    // 组内合并：留最早（id 最小）那行
    list.sort((a, b) => a.id - b.id)
    const keep = list[0]
    const maxStrength = Math.max(...list.map((x) => Number(x.strength) || 1))
    const lastDay = list.map((x) => String(x.lastDay)).sort().pop()
    const want = normalizeMarkText(keep.text)
    console.log(`合并 [${want}]：保留 id=${keep.id}「${keep.text}」strength=${keep.strength}→${maxStrength}`)
    for (const extra of list.slice(1)) {
      console.log(`  删 id=${extra.id}「${extra.text}」(strength=${extra.strength})`)
    }
    merged += 1
    if (apply) {
      // ⚠ 顺序要紧：先删多余的，再改保留行的 norm。
      // 反过来的话，保留行尚未改成新 norm，而 UNIQUE(key,norm) 已经占着 ——
      // 实测报错 UNIQUE constraint failed。
      for (const extra of list.slice(1)) drop.run(extra.id)
      touch.run(want, maxStrength, lastDay, keep.id)
    }
  }
  if (apply) db.exec('COMMIT')
  else db.exec('ROLLBACK')
} catch (e) {
  try { db.exec('ROLLBACK') } catch { /* ignore */ }
  throw e
}

console.log('')
console.log(`${apply ? '已应用' : '试运行（加 --apply 才写）'}：合并 ${merged} 组`)
console.log('剩余标记数:', db.prepare('SELECT COUNT(*) n FROM covenant_marks').get().n)
db.close()
