// 用真实库，模拟她下一次唤醒时「契阔」这一段会长什么样。
// 只读，不写库、不启桥。
//
// ⚠ 2026-10-29 重写：原来这个脚本**自己拼了一套注入逻辑**（和 src/bridge.js 的
// formatCovenantLineV2 是两份实现）。于是"预览"和"实际注入"可能不一致 ——
// 实测 bridge 已改成多封，这里还只显示一封，会误导接手的人。
//
// 现在的做法：把**拼装逻辑抽到 src/covenant-inject.mjs**（纯函数），
// bridge 和本脚本都调它。预览 = 实际。
//
// 用法：node preview-covenant.mjs [key]
import fs from 'node:fs'
import path from 'node:path'
import { CovenantStore, localDay } from './src/covenant-store.mjs'
import { formatCovenantBlock, covenantInjectConfig } from './src/covenant-inject.mjs'
import { collectMarkTrail, formatMarkTrail } from './src/covenant-facts.mjs'

const ROOT = path.resolve(import.meta.dirname)
const DB = path.join(ROOT, 'state', 'archive.db')
const KEY = process.argv[2] || 'private:<OWNER_QQ>'

if (!fs.existsSync(DB)) {
  console.error(`没有库：${DB}`)
  process.exit(1)
}

const store = new CovenantStore(DB)
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const injectCfg = covenantInjectConfig(cfg?.socialV2?.covenant)

if (!store.latestLetter(KEY)) {
  console.log('（还没有任何一封信）')
  store.close()
  process.exit(0)
}

const perf = Date.now()
const body = formatCovenantBlock({
  store,
  key: KEY,
  today: localDay(),
  config: injectCfg,
  // 走势那段：与 bridge 用的是同一份实现
  markTrail: (mark) => {
    try { return formatMarkTrail(collectMarkTrail({ store, key: KEY, mark })) } catch { return '' }
  },
})

console.log('\n================ 她下次醒来会读到的「契阔」 ================\n')
console.log(body || '（空）')
console.log('============================================================')
console.log(`字数 ${[...body].length}，本轮统计耗时 ${Date.now() - perf}ms`)
console.log(`\n[配置] fullLetters=${injectCfg.fullLetters} markLimit=${injectCfg.markLimit}`)

const all = store.letters(KEY, 60)
console.log(`[库] 信 ${all.length} 封（${all.slice(0, 6).map((l) => `${l.day}v${l.version}`).join(' ')}${all.length > 6 ? ' …' : ''}）`)
console.log(`[库] 现行 ${store.markCount(KEY)} / 孤儿 ${store.unsupportedMarks(KEY, 10).length} / 退役 ${store.retiredMarks(KEY, 10).length}`)
store.close()
