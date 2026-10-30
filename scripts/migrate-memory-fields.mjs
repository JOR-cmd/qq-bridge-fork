// 记忆系统 migration：给 archive.db 加"重要性 / 访问统计 / 归档状态 / 层级"字段。
//
// 设计原则（照搬 memory-brain 的 schema 思路，但只借字段设计，不复制它的代码）：
//   · **幂等**：重复运行不会报错，只会跳过已存在的列
//   · **非破坏**：只 ADD COLUMN，从不 DROP / 改类型 / 改数据
//   · **可回滚**：备份在 state/backup/archive.db.pre-migration-*
//
// 字段含义（来自 memory-brain store.py:667-694 的实践）：
//   messages.importance  0~1，默认 0.5。每日衰减 1%，近30天访问过的减半衰减
//   messages.access_count 被真正注入的次数（不是被检索到的次数）
//   messages.last_access  最后一次被注入的时间（毫秒）
//   messages.status       active / archived。archived 不参与主动检索
//   covenant_marks.tier   L4=锚（永不衰减）、L3=事件（90天）、L2=画像（180天）、L1=事实（30天）
//   covenant_marks.last_access 最后一次被提到的时间，用于锚的排序
//
// ⚠️ 为什么 covenant_marks 默认 L4 而不是 L3：
//   实测她的 9 条标记里 7 条是关系/承诺类（「怕换个上下文我变陌生」「你陪着就够了」），
//   这些按 memory-brain 的定义就该是 L4（永不衰减）。
//
// 用法：
//   node scripts/migrate-memory-fields.mjs          # 执行
//   node scripts/migrate-memory-fields.mjs --check  # 只检查，不改
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'archive.db');
const CHECK_ONLY = process.argv.includes('--check');

if (!fs.existsSync(DB)) {
  console.error(`没有库：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);

/** 表已有的列名 */
const columnsOf = (table) => {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));
  } catch {
    return new Set();
  }
};

/**
 * 加一列（幂等）。
 * SQLite 的 ALTER TABLE ADD COLUMN 只能追加，不能改已有列 —— 这正好符合"非破坏"。
 */
function addColumn(table, col, ddl) {
  const cols = columnsOf(table);
  if (!cols.size) { console.log(`  ⚠ 表 ${table} 不存在，跳过`); return false; }
  if (cols.has(col)) { console.log(`  = ${table}.${col} 已存在`); return false; }
  if (CHECK_ONLY) { console.log(`  + ${table}.${col} 待添加`); return true; }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  ✓ ${table}.${col} 已添加`);
  return true;
}

console.log(`=== 记忆字段 migration ${CHECK_ONLY ? '（仅检查）' : ''} ===`);
console.log(`库: ${DB}`);
console.log();

console.log('[1] messages：重要性与访问统计');
addColumn('messages', 'importance', 'importance REAL NOT NULL DEFAULT 0.5');
addColumn('messages', 'access_count', 'access_count INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'last_access', 'last_access INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'status', "status TEXT NOT NULL DEFAULT 'active'");

console.log();
console.log('[2] covenant_marks：层级与访问时间');
addColumn('covenant_marks', 'tier', "tier TEXT NOT NULL DEFAULT 'L4'");
addColumn('covenant_marks', 'last_access', 'last_access INTEGER NOT NULL DEFAULT 0');

console.log();
console.log('[3] 索引（让衰减与检索不走全表扫描）');
if (!CHECK_ONLY) {
  // status + importance 的组合查询是衰减任务的主力
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_status_importance ON messages(status, importance)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_last_access ON messages(last_access)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_marks_tier ON covenant_marks(tier)');
  console.log('  ✓ 3 个索引就绪（IF NOT EXISTS，幂等）');
} else {
  console.log('  （检查模式：不建索引）');
}

// ── 给现有数据补初始值 ───────────────────────────────────────────────
//
// 为什么需要：
//   · messages 的 importance 默认 0.5，但我们希望"有情绪/有关键词的"初始就高一点，
//     否则一年后所有消息一起从 0.5 开始衰减，等于没有区分。
//   · last_access 默认 0，会导致"从未被访问"的记忆立刻被归档判定命中。
//     用 created_at(t) 作为初始 last_access，给它们一个公平的起点。
if (!CHECK_ONLY) {
  console.log();
  console.log('[4] 回填初始值（只动默认值所在的行，不覆盖已有）');
  const r1 = db.prepare("UPDATE messages SET last_access = t WHERE last_access = 0").run();
  console.log(`   messages.last_access ← t：${r1.changes} 行`);
  const r2 = db.prepare("UPDATE covenant_marks SET last_access = 0 WHERE last_access IS NULL").run();
  // marks 没有时间戳字段可回填；保持 0 表示"从未被提起"，由锚的排序把它放后面。
  console.log(`   covenant_marks.last_access 初始化：${r2.changes} 行`);
}

console.log();
console.log('[5] 迁移后结构');
for (const t of ['messages', 'covenant_marks']) {
  console.log(`  ${t}: ${[...columnsOf(t)].join(', ')}`);
}
const counts = {
  messages: db.prepare('select count(*) c from messages').get().c,
  marks: db.prepare('select count(*) c from covenant_marks').get().c,
};
console.log(`  行数: messages=${counts.messages} marks=${counts.marks}`);

db.close();
console.log();
console.log(CHECK_ONLY ? '（检查完成，未修改）' : '✅ migration 完成');
