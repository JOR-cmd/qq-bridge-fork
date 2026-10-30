// 回填历史消息的话题标签（一次性）。
//
// 为什么需要：新消息入库时会自动打标签（archive-store.addMany），
// 但 917 条历史消息是在加这个字段之前入库的，tags 全是空串。
// 不回填的话，图谱扩散只能看到"新消息"，历史进不了扩散池。
//
// 用法：
//   node scripts/backfill-tags.mjs --dry-run
//   node scripts/backfill-tags.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractTags, serializeTags } from '../src/topic-tags.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'archive.db');
const DRY = process.argv.includes('--dry-run');

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 3000');

console.log(`=== 话题标签回填 ${DRY ? '（dry-run）' : ''} ===`);

const rows = db.prepare("SELECT id, text FROM messages WHERE tags = ''").all();
console.log(`待处理: ${rows.length} 条（tags 为空）`);

const updates = [];
const dist = {};
for (const r of rows) {
  const tags = extractTags(String(r.text || ''));
  if (!tags.length) continue;
  for (const t of tags) dist[t] = (dist[t] || 0) + 1;
  updates.push([serializeTags(tags), Number(r.id)]);
}

console.log(`能打上标签的: ${updates.length} 条 = ${(updates.length / Math.max(1, rows.length) * 100).toFixed(0)}%`);
console.log();
console.log('=== 各话题 ===');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)} 条`);
}

console.log();
console.log('=== 抽样 ===');
for (let i = 0; i < Math.min(6, updates.length); i += 1) {
  const r = rows.find((x) => Number(x.id) === updates[i][1]);
  if (r) console.log(`  [${updates[i][0]}] ← 「${String(r.text).slice(0, 38)}」`);
}

if (DRY) {
  console.log();
  console.log('（dry-run：未写入）');
} else {
  const stmt = db.prepare("UPDATE messages SET tags=? WHERE id=? AND tags=''");
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
