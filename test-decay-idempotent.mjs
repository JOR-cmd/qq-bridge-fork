// 记忆衰减幂等回归（**先验证，再实现**）。
// 用法：node test-decay-idempotent.mjs
//
// 锁住 2026-10-30 修 bug D 时**我自己引入**的一个洞：
//   调度器改成"失败不记账、冷却后重试"之后，**重试会把同一天衰减两遍** ——
//   因为 decay-memory.mjs 本身不是幂等的（它是"按当前值再乘 (1-rate)"），
//   而且它没有任何"今天跑过没有"的守卫。
//
// 现在脚本自带幂等守卫（meta 表 decay:lastDay，与衰减写在同一事务）。
// 这个测试用临时目录真跑两遍脚本，断言第二遍**不再衰减**。
//
// ⚠️ 全程在 os.tmpdir() 下的副本里跑，不碰真实 state/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}  ${d}`); } };

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-idem-'));
fs.mkdirSync(path.join(dir, 'state'));
fs.mkdirSync(path.join(dir, 'scripts'));
fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'decay-memory.mjs'), path.join(dir, 'scripts', 'decay-memory.mjs'));

// 造一个最小的 messages 表（够 decay 脚本跑起来）
const dbPath = path.join(dir, 'state', 'archive.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, t INTEGER, iso TEXT,
      side TEXT, sender TEXT, text TEXT, hash TEXT,
      importance REAL NOT NULL DEFAULT 0.5, access_count INTEGER NOT NULL DEFAULT 0,
      last_access INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      archived_at INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE messages_fts (rowid INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE covenant_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, norm TEXT, text TEXT,
      strength REAL DEFAULT 1, firstDay TEXT, lastDay TEXT, supported INTEGER DEFAULT 1,
      missCount INTEGER DEFAULT 0, retiredAt TEXT, retireWhy TEXT, retirePred TEXT,
      retiredVerdict TEXT, retiredNote TEXT, checkedAt TEXT, checkText TEXT,
      checkState TEXT, checkAt TEXT, checkNote TEXT, tier TEXT DEFAULT 'L4',
      last_access INTEGER DEFAULT 0
    );
  `);
  const ins = db.prepare('INSERT INTO messages(key,t,iso,side,sender,text,hash,importance) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 5; i++) ins.run('private:1', 1790000000000 + i, 'x', 'him', 'a', 'msg' + i, 'h' + i, 0.5);
  db.close();
}

const runOnce = () => execFileSync(process.execPath, ['scripts/decay-memory.mjs'], { cwd: dir, stdio: 'pipe' });
const readImp = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const r = db.prepare('SELECT importance FROM messages ORDER BY id').all().map((x) => Number(x.importance));
  let meta = null;
  try { meta = db.prepare("SELECT v FROM meta WHERE k='decay:lastDay'").get()?.v ?? null; } catch { /* 表还没建 */ }
  db.close();
  return { imp: r, meta };
};

console.log('\n[1] 第一遍应该真的衰减并记账');
const before = readImp();
runOnce();
const after1 = readImp();
ck('第一遍真的降低了 importance', after1.imp[0] < before.imp[0], `${before.imp[0]} → ${after1.imp[0]}`);
ck('第一遍写入了 meta 记账', after1.meta !== null, String(after1.meta));
ck('记账值是本地日期', /^\d{4}-\d{2}-\d{2}$/.test(String(after1.meta)), String(after1.meta));

console.log('\n[2] 第二遍（同一天）必须跳过，不能再衰减');
runOnce();
const after2 = readImp();
ck('第二遍 importance **完全没变**', JSON.stringify(after2.imp) === JSON.stringify(after1.imp), `${JSON.stringify(after1.imp)} → ${JSON.stringify(after2.imp)}`);
ck('第二遍后 meta 仍是同一天（没被改成别的）', after2.meta === after1.meta, `${after1.meta} vs ${after2.meta}`);

console.log('\n[3] --force 应该能强制重跑（给"想手动补一次"的人留出口）');
execFileSync(process.execPath, ['scripts/decay-memory.mjs', '--force'], { cwd: dir, stdio: 'pipe' });
const after3 = readImp();
ck('--force 后 importance 确实又降了', after3.imp[0] < after2.imp[0], `${after2.imp[0]} → ${after3.imp[0]}`);

console.log('\n[4] 幂等守卫写在源码里（防止被"优化"掉）');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'decay-memory.mjs'), 'utf8');
  ck('有 decay:lastDay 记账键', src.includes('decay:lastDay'));
  ck('有已跑过就跳过的判断', src.includes('已经跑过一次了') || src.includes('alreadyDay === todayLocal'));
  ck('记账与衰减在同一事务（BEGIN/COMMIT 包住记账）', /BEGIN[\s\S]{0,800}tMeta\.run/.test(src), '');
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
