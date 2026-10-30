// 只读推演（临时副本）。专测：当「要记牢」等固定段本身超出预算时，注入块会怎样。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatCovenantBlock, covenantInjectConfig } from '../src/covenant-inject.mjs';
import { CovenantStore } from '../src/covenant-store.mjs';

const KEY = 'private:<OWNER_QQ>';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
const DB = path.join(TMP, 'a.db');
for (const s of ['', '-wal', '-shm']) {
  const f = `state/archive.db${s}`;
  if (fs.existsSync(f)) fs.copyFileSync(f, DB + s);
}
const db = new DatabaseSync(DB);
const store = new CovenantStore(DB);
const cfg = covenantInjectConfig({ fullLetters: 3, markLimit: 5, maxChars: 1200 });

const long = '要记牢的这件事，他说的那句话，我不想忘。'.repeat(12); // 每条 216 字
db.prepare('UPDATE covenant_marks SET text=? WHERE retiredAt IS NULL').run(long);

const marks = store.topMarks(KEY, 5, { includeUnsupported: false });
console.log('前 5 条标记长度:', marks.map((m) => [...m.text].length).join(', '));

const out = formatCovenantBlock({ store, key: KEY, today: '2026-10-29', config: cfg });
const n = [...out].length;
console.log('注入总长:', n, '| 上限', cfg.maxChars, '|', n > cfg.maxChars ? '⚠ 超出' : '未超');
console.log('触发压缩:', out.includes('契阔太长'));

// 拆开看每段长度
for (const blk of out.split('\n\n').filter((b) => b.trim())) {
  const head = blk.startsWith('【') ? blk.slice(0, blk.indexOf('】') + 1) : '(正文)';
  console.log(`  ${String([...blk].length).padStart(4)} 字  ${head}`);
}
db.close();
console.log('\n结论：maxChars 只管「最近 N 封」那一段；要记牢/孤儿/待核等固定段**整段保留、不参与压缩**。');
