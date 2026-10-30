// 冷存储：把当前会话窗口里的消息写进 state/archive.db（SQLite，幂等）
//
// 为什么需要它：桥接的 state/social-v2.json 只保留最近 100 条消息，
// 更早的会滑出窗口 —— 之后既查不到、也喂不回提示词。
// 这个脚本只做「多存一份」，不改桥接任何行为；重复消息靠 UNIQUE(key,t,side,hash) 跳过。
//
// 用法：node scripts/archive.mjs          追加一次
//       node scripts/archive.mjs --stats  只看统计
import fs from 'node:fs'
import path from 'node:path'
import { ArchiveStore, importJsonl } from '../src/archive-store.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const STATE = path.join(ROOT, 'state')
const SRC = path.join(STATE, 'social-v2.json')
const DB = path.join(STATE, 'archive.db')
const LEGACY = path.join(STATE, 'archive')
const statsOnly = process.argv.includes('--stats')

if (!fs.existsSync(SRC)) {
  console.log('没有 social-v2.json，跳过')
  process.exit(0)
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'))
const conversations = raw.conversations ?? {}
const store = new ArchiveStore(DB)

try {
  for (const [key, state] of Object.entries(conversations)) {
    const messages = [...(state.recentMessages ?? []), ...(state.unread ?? [])]
      .filter((m) => m && typeof m.text === 'string' && m.text.trim() && Number.isFinite(Number(m.time)))
      .sort((a, b) => Number(a.time) - Number(b.time))
      .map((m) => ({
        t: Number(m.time),
        side: m.isSelf ? 'her' : 'him',
        sender: String(m.sender ?? ''),
        text: m.text,
      }))

    if (statsOnly) {
      console.log(`${key}: 库内 ${store.count(key)} 条 | 当前窗口 ${messages.length} 条`)
      continue
    }

    // 先把老的 jsonl 归档导入（首次运行时的迁移），再写当前窗口
    const imported = importJsonl(store, path.join(LEGACY, key.replace(/[<>:"/\\|?*]/g, '_')), key)
    const added = store.addMany(key, messages)
    console.log(
      `${key}: 库内 ${store.count(key)} 条 | 本次新增 ${added}`
      + (imported ? ` | 迁移 jsonl ${imported} 条` : '')
      + ` | 窗口 ${messages.length} 条`,
    )
  }
} finally {
  store.close()
}

if (!statsOnly) console.log(`\n数据库: ${DB}`)
