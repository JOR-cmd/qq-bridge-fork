// 冷存储（SQLite）：桥接与脚本共用的消息存档 + 检索。
//
// 为什么用 SQLite 而不是 jsonl：
//   - 去重靠 UNIQUE(key,t,side,hash)，不用每次重扫文件
//   - 十万行查询走索引（<10ms），jsonl 是全扫
//   - 单文件，搬到云上就是拷一个 .db
//   - 零依赖：Node 22.13+ 自带 node:sqlite（用 DatabaseSync，别用较新的 Database 别名）
//
// 检索用混合策略（实测出来的坑）：
//   FTS5 的 trigram 分词器按 3 字符切，中文两字词（洗澡/开池/表情）根本进不了索引，
//   所以 ≥3 字走 MATCH，≤2 字走 LIKE，两路结果合并后按命中词数打分。
import fs from 'node:fs'
// 话题标签（"图谱"的极简版）：给每条消息打几个话题，供检索扩散用。
import { extractTags, serializeTags, parseTags, tagOverlap } from './topic-tags.mjs'
// importance 估算（与 scripts/backfill-importance.mjs 共用同一份实现，避免口径漂移）
import { estimateImportance } from './importance-estimate.mjs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const CJK = /[\u4e00-\u9fff]/

function safeKey(key) {
  return String(key ?? '')
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

export class ArchiveStore {
  constructor(dbPath) {
    this.path = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS messages (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        key     TEXT NOT NULL,
        t       INTEGER NOT NULL,
        iso     TEXT NOT NULL,
        side    TEXT NOT NULL,
        sender  TEXT NOT NULL,
        text    TEXT NOT NULL,
        hash    TEXT NOT NULL,
        -- 2026-10-30：记忆衰减所需字段（照 memory-brain store.py 的 schema 设计）
        --   importance 0~1，每日衰减 1%；近 30 天被访问过的衰减减半
        --   access_count 被真正注入提示词的次数（不是被检索到的次数）
        --   last_access 最后一次被注入的时间（毫秒）
        --   status active / archived —— archived 不参与主动检索但仍可查
        importance   REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access  INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active',
        -- 2026-10-30：话题标签（"图谱"的极简版）。
        -- 存「洗澡,游戏」这种逗号串，不建 entities/relations 两张表 ——
        -- 实测她的对话上那两张表几乎是空的（关系只有 4 条），建了等于没建。
        -- 用途：检索命中一条后，按共同话题**扩散**出一小组相关记忆。
        tags         TEXT NOT NULL DEFAULT '',
        -- ⚠️ 2026-10-30 深度自检抓到的漏洞：
        --   删除条件原来用 last_access 判断"归档超过 180 天"，但 last_access 是
        --   "最后被注入"的时间，不是"归档"的时间。一条消息归档时 last_access
        --   可能已经是 1 年前 → 归档当天就被立刻删掉，180 天保护期形同虚设。
        --   必须单独记归档时间，180 天从这里开始算。
        archived_at  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(key, t, side, hash)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_key_t ON messages(key, t);
      -- 衰减/归档任务的主力查询（status + importance）
      CREATE INDEX IF NOT EXISTS idx_messages_status_importance ON messages(status, importance);
      CREATE INDEX IF NOT EXISTS idx_messages_last_access ON messages(last_access);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram');
    `)
    // ── 老库升级（2026-10-30）：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
    //    所以这里像 covenant-store 的 #migrate 一样逐列检查补齐。
    //    没有这段的话：跑过旧版本的库在新代码下会报 "no such column: importance"。
    {
      const cols = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map((r) => String(r.name)))
      const wanted = [
        ['importance', 'REAL NOT NULL DEFAULT 0.5'],
        ['access_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['last_access', 'INTEGER NOT NULL DEFAULT 0'],
        ['status', "TEXT NOT NULL DEFAULT 'active'"],
        ['archived_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['tags', "TEXT NOT NULL DEFAULT ''"],
      ]
      for (const [name, ddl] of wanted) {
        if (!cols.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`)
      }
      // last_access 默认 0 会让"从未被访问"的记忆立刻命中归档条件，
      // 用入库时间(t)作为公平起点。
      if (!cols.has('last_access')) {
        this.db.exec('UPDATE messages SET last_access = t WHERE last_access = 0')
      }
    }
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages(key,t,iso,side,sender,text,hash) VALUES (?,?,?,?,?,?,?)
    `)
    this.ftsStmt = this.db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)')
    this.tagStmt = this.db.prepare('UPDATE messages SET tags=? WHERE id=?')
    this.importanceStmt = this.db.prepare('UPDATE messages SET importance=? WHERE id=?')
    this.likeStmt = this.db.prepare(`
      SELECT id,t,iso,side,sender,text,importance,access_count,last_access FROM messages
      WHERE key = ? AND text LIKE ? AND t < ? ORDER BY t DESC LIMIT ?
    `)
  }

  /**
   * 批量写入；已存在（key,t,side,hash 相同）的自动跳过。
   * @param {string} key
   * @param {{t:number,iso?:string,side:string,sender?:string,text:string}[]} rows
   * @returns {number} 实际新增条数
   */
  addMany(key, rows) {
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        const t = Number(row.t)
        const text = String(row.text ?? '')
        if (!Number.isFinite(t) || !text.trim()) continue
        const info = this.insertStmt.run(
          safeKey(key),
          t,
          row.iso ?? new Date(t).toISOString(),
          String(row.side ?? 'him'),
          String(row.sender ?? ''),
          text,
          hashText(text),
        )
        if (info.changes > 0) {
          this.ftsStmt.run(info.lastInsertRowid, text)
          added += 1
          // 2026-10-30：顺手给新消息打话题标签 + 估初始 importance。
          //
          // 为什么标签要在这里：新消息不打标签，图谱只会越用越旧。
          // 为什么 importance 也要：回填脚本只处理"历史存量"，新消息如果不算，
          //   会永远是 0.5 —— 三因子里的 importance 那一项对新消息恒等，等于没区分。
          //
          // 判据与 scripts/backfill-importance.mjs **保持一致**（否则新旧消息口径不同）：
          //   媒体占位符 0.35 / 无情绪 ≤4 字 0.4 / 无情绪 0.5 / 有情绪 0.55~0.85
          //
          // 失败一律吞掉 —— 这两个只影响排序质量，绝不该影响入库。
          try {
            const tags = extractTags(text)
            if (tags.length) this.tagStmt.run(serializeTags(tags), info.lastInsertRowid)
          } catch { /* 标签失败不影响入库 */ }
          try {
            const imp = estimateImportance(text)
            this.importanceStmt.run(imp, info.lastInsertRowid)
          } catch { /* 重要性失败不影响入库 */ }
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
    return added
  }

  count(key) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE key = ?').get(safeKey(key))
    return Number(row?.n ?? 0)
  }

  /**
   * 混合检索。
   * @param {object} options
   * @param {string} options.key
   * @param {string[]} options.tokens  已切好的查询词（中文片段/英文词）
   * @param {number} [options.before]  只看这个时间之前（排除当前对话窗口）
   * @param {number} [options.limit]
   * @param {number} [options.minHits] 至少命中几个词
   */
  search({ key, tokens, before = Date.now(), limit = 2, minHits = 2, pool = 400 }) {
    const terms = [...new Set(tokens.filter((x) => x && x.length > 0))]
    if (!terms.length) return []

    const candidates = new Map()
    const longTerms = terms.filter((x) => Array.from(x).length >= 3)

    // ① FTS5（≥3 字）：每个词单独查，避免 MATCH 语法把用户输入当运算符
    for (const term of longTerms) {
      let rows = []
      try {
        rows = this.db.prepare(`
          SELECT m.id,m.t,m.iso,m.side,m.sender,m.text,m.importance,m.access_count,m.last_access
          FROM messages_fts f JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ? AND m.key = ? AND m.t < ?
          ORDER BY m.t DESC LIMIT ?
        `).all(`"${term.replace(/"/g, '""')}"`, safeKey(key), before, pool)
      } catch {
        rows = []
      }
      for (const row of rows) candidates.set(row.id, row)
    }

    // ② LIKE（1~2 字，trigram 覆盖不到）
    for (const term of terms.filter((x) => Array.from(x).length < 3)) {
      const rows = this.likeStmt.all(safeKey(key), `%${term}%`, before, pool)
      for (const row of rows) candidates.set(row.id, row)
    }

    const scored = []
    for (const row of candidates.values()) {
      const text = String(row.text ?? '')
      let hits = 0
      for (const term of terms) if (text.includes(term)) hits += 1
      if (hits < minHits) continue
      scored.push({ ...row, hits })
    }
    scored.sort((a, b) => b.hits - a.hits || b.t - a.t)
    return scored.slice(0, limit)
  }

  /**
   * 记「这几条真的被注入进提示词了」（2026-10-30）。
   *
   * ⚠️ 深度自检抓到的漏洞：加了 access_count 字段、衰减逻辑也读它来"访问多则衰减慢"，
   *   但**从来没有任何地方写过它** → 那个机制一直是死的。
   *
   * 为什么只对"真正被注入的"调用（不是对检索到的全部）：
   *   照抄 memory-brain store.py:667-694 的语义 —— 它是"被访问过"的减半衰减。
   *   如果对候选集全量强化，那些根本没进提示词的也涨了，
   *   等于把噪声当成"重要"，一年后所有记忆一样重。
   */
  /**
   * 按话题标签扩散：给几条「已经命中的」消息，找回和它们同话题的其它消息。
   *
   * 这是"图谱"的实际价值 —— 不是替代检索，是把找到的一条扩成一小组。
   * 实测：「上次打游戏打到第几把」FTS 1 条 → 按话题扩散 8 条。
   *
   * ⚠️ 硬前提：必须有种子。种子都没有时返回空数组 ——
   *   实测「我不吃香菜」这类从没提过的东西，扩散也救不回来。
   *
   * @param {string} key
   * @param {number[]} seedIds 已经命中的消息 id
   * @param {object} opts
   * @param {number} opts.limit 最多带回几条（默认 2 —— 扩散不该喧宾夺主）
   * @param {number} opts.before 只看此时刻之前
   * @returns {Array<{id,t,text,tags,overlap}>} 按重叠度降序
   */
  expand({ key, seedIds = [], limit = 2, before = Date.now() } = {}) {
    try {
      const seeds = [...new Set((seedIds || []).map(Number).filter(Number.isFinite))]
      if (!seeds.length) return []
      // 取种子的话题集合
      const seedRows = this.db.prepare(
        `SELECT id,tags FROM messages WHERE id IN (${seeds.map(() => '?').join(',')})`,
      ).all(...seeds)
      const seedTags = new Set()
      for (const r of seedRows) for (const t of parseTags(r.tags)) seedTags.add(t)
      if (!seedTags.size) return []

      // 找有共同话题的其它消息。用 LIKE 逐话题查（739 条规模，够快），
      // 再按 Jaccard 重叠度排序 —— 不用"交集数"，否则标签多的永远排前面。
      const cand = new Map()
      for (const tag of seedTags) {
        const rows = this.db.prepare(
          `SELECT id,t,text,side,sender,tags FROM messages
           WHERE key=? AND status='active' AND t < ? AND tags LIKE ?
           ORDER BY t DESC LIMIT 20`,
        ).all(safeKey(key), Number(before), `%${tag}%`)
        for (const r of rows) if (!seeds.includes(Number(r.id))) cand.set(Number(r.id), r)
      }
      const out = [...cand.values()]
        .map((r) => ({ ...r, overlap: tagOverlap([...seedTags], parseTags(r.tags)) }))
        .filter((r) => r.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || Number(b.t) - Number(a.t))
        .slice(0, Math.max(1, Math.min(10, Number(limit) || 2)))
      return out
    } catch {
      return []   // 扩散失败绝不影响主检索
    }
  }

  touchAccess(ids, now = Date.now()) {
    try {
      const list = (Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
      if (!list.length) return 0
      const stmt = this.db.prepare('UPDATE messages SET access_count = access_count + 1, last_access = ? WHERE id = ?')
      let n = 0
      for (const id of list) n += Number(stmt.run(Number(now), id).changes) || 0
      return n
    } catch {
      return 0   // 只影响排序权重，失败不该影响检索本身
    }
  }

  close() {
    try { this.db.close() } catch { /* ignore */ }
  }
}

/** 把 state/archive/<key>/*.jsonl 导入数据库（幂等）。 */
export function importJsonl(store, dir, key) {
  if (!fs.existsSync(dir)) return 0
  const rows = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row && typeof row.text === 'string' && Number.isFinite(Number(row.t))) rows.push(row)
      } catch { /* 半行跳过 */ }
    }
  }
  return store.addMany(key, rows)
}
