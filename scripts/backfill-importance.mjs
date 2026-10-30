// 给现有消息初始化 importance（一次性回填）。
//
// 为什么需要（2026-10-30 深度自检抓到的漏洞）：
//   所有 896 条都是 importance=0.5 → 三因子里的 importance 项对所有消息恒等 →
//   那一项等于没起作用。这跟"全等文件柜"是同一个病，只是换了个字段名。
//
// ⚠️ 判据统一走 src/importance-estimate.mjs —— 与 archive-store 的新消息入库
//    共用同一份实现。写在两处必然漂移（这个项目踩过：preview-covenant 与 bridge
//    各写一份注入逻辑，结果预览和实际不一致）。
//
// 用法：
//   node scripts/backfill-importance.mjs --dry-run
//   node scripts/backfill-importance.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { estimateImportance } from '../src/importance-estimate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'archive.db');
const DRY = process.argv.includes('--dry-run');

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 3000');

console.log(`=== importance 回填 ${DRY ? '（dry-run）' : ''} ===`);

// 只处理"还是默认值"的行 —— 绝不覆盖已经因为访问而变化的那些
const rows = db.prepare(
  'SELECT id, text, side, importance FROM messages WHERE importance = 0.5 AND access_count = 0',
).all();
console.log(`待评估: ${rows.length} 条（importance 仍是默认 0.5 且从未被访问）`);

const updates = [];
const dist = {};
for (const r of rows) {
  const value = estimateImportance(String(r.text || ''));
  const bucket = value <= 0.359 ? '媒体(0.35)'
    : (value <= 0.409 ? '极短寒暄(0.40)'
      : (value <= 0.509 ? '普通(0.50)'
        : `有情绪(${value.toFixed(2)})`));
  dist[bucket] = (dist[bucket] || 0) + 1;
  updates.push([value, Number(r.id)]);
}

console.log();
console.log('=== 回填后的分布 ===');
for (const [k, v] of Object.entries(dist).sort()) console.log(`  ${k}: ${v} 条`);

console.log();
console.log('=== 抽样（前 8 条）===');
for (let i = 0; i < Math.min(8, updates.length); i += 1) {
  const r = rows.find((x) => Number(x.id) === updates[i][1]);
  if (r) console.log(`  ${updates[i][0].toFixed(2)} ← 「${String(r.text).slice(0, 34)}」`);
}

if (DRY) {
  console.log();
  console.log('（dry-run：未写入）');
} else {
  const stmt = db.prepare('UPDATE messages SET importance=? WHERE id=? AND importance=0.5 AND access_count=0');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const [v, id] of updates) n += Number(stmt.run(v, id).changes) || 0;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('写入失败已回滚:', e?.message ?? e);
    process.exit(1);
  }
  console.log();
  console.log(`✅ 写入 ${n} 条`);
}
db.close();
