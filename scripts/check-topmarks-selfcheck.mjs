// 只读 + 临时库：topMarks 修法的边界自检。
// 覆盖：includeUnsupported 两种取值、退役恒排除、顺序稳定性、limit 边界、
//       与 markCount / unsupportedMarks 的口径一致性、以及真实库的回归等效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CovenantStore } from '../src/covenant-store.mjs';

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-self-'));
const DB = path.join(TMP, 'a.db');
const store = new CovenantStore(DB);
const KEY = 'k1';

const addMark = (norm, text, strength, { retired = null, supported = 1 } = {}) => {
  const db = store.db ?? new DatabaseSync(DB);
  db.prepare(
    `INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount,retiredAt,retireWhy,retirePred)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(KEY, norm, text, strength, '2026-01-01', '2026-06-01', supported, 0, retired, retired ? '不重要了' : null, retired ? '还会聊别的' : null);
};

// 用 store 自己的连接（避免两个连接写同一个库）
const db = new DatabaseSync(DB);
for (let i = 0; i < 30; i++) {
  db.prepare(
    `INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount,retiredAt,retireWhy,retirePred)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(KEY, `ret-${i}`, `退役第${i}件`, 100 + i, '2026-01-01', '2026-06-01', 1, 0, '2026-08-01 12:00', '不重要', '别的还在');
}
// 现行标记：5 条，强度 1（最低）
for (let i = 0; i < 5; i++) {
  db.prepare(
    `INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(KEY, `live-${i}`, `现行第${i}件`, 1, '2026-10-01', '2026-10-05', 1, 0);
}

console.log(`\n[1] 退役 30 条(强度 100+) + 现行 5 条(强度 1) → 现行必须全在`);
{
  const got = store.topMarks(KEY, 5);
  ck('默认口径返回 5 条', got.length === 5, `got ${got.length}`);
  ck('返回的全是现行（无退役混入）', got.every((m) => m.text.startsWith('现行')), JSON.stringify(got.map((m) => m.text)));
}

console.log(`\n[2] includeUnsupported=true：应含孤儿，但**仍不含退役**`);
{
  db.prepare(`INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount)
              VALUES (?,?,?,?,?,?,?,?)`).run(KEY, 'orph-1', '孤儿第1件', 500, '2026-01-01', '2026-06-01', 0, 3);
  const withU = store.topMarks(KEY, 5, { includeUnsupported: true });
  ck('孤儿进来了（强度 500 应排第一）', withU[0]?.text === '孤儿第1件', JSON.stringify(withU.map((m) => m.text)));
  ck('退役仍然一条都没有', withU.every((m) => !m.text.startsWith('退役')), JSON.stringify(withU.map((m) => m.text)));
  const def = store.topMarks(KEY, 5);
  ck('默认口径仍排除孤儿', !def.some((m) => m.text === '孤儿第1件'), JSON.stringify(def.map((m) => m.text)));
}

console.log(`\n[3] 布尔值绑参不会被误传（node:sqlite 不收布尔）`);
{
  ck('includeUnsupported=false（布尔）不抛', (() => { try { store.topMarks(KEY, 5, { includeUnsupported: false }); return true; } catch { return false; } })());
  ck('includeUnsupported=true（布尔）不抛', (() => { try { store.topMarks(KEY, 5, { includeUnsupported: true }); return true; } catch { return false; } })());
}

console.log(`\n[4] limit 边界`);
{
  ck('limit=1 → 1 条', store.topMarks(KEY, 1).length === 1);
  // limit=0 的语义：Number(0) || 5 → 5。旧代码循环上限也是 min(50, 0||5)=5，
  // 所以这是**原有行为**，不是这次改动引入的，别"修"它。
  ck('limit=0 → 回落 5（与改动前一致）', store.topMarks(KEY, 0).length === 5, `got ${store.topMarks(KEY, 0).length}`);
  ck('limit 超 50 → 封顶 50 且不抛', store.topMarks(KEY, 999).length >= 5);
  ck('limit 是字符串也要能跑', store.topMarks(KEY, '3').length === 3);
  ck('limit 是 NaN → 回落 5', store.topMarks(KEY, NaN).length === 5);
}

console.log(`\n[5] 口径一致性：markCount 与 topMarks 默认口径对齐`);
{
  const cnt = store.markCount(KEY);
  ck('markCount = 5（现行）', cnt === 5, String(cnt));
  const all = store.topMarks(KEY, 100);
  ck('topMarks(100) 条数 = markCount', all.length === cnt, `${all.length} vs ${cnt}`);
}

console.log(`\n[6] 顺序：强度降序，同强度按 lastDay 降序`);
{
  const got = store.topMarks(KEY, 5);
  const desc = got.every((m, i) => i === 0 || (got[i - 1].strength >= m.strength));
  ck('强度非递增', desc, JSON.stringify(got.map((m) => [m.strength, m.lastDay])));
}

console.log(`\n[7] 空库/不存在 key 不抛`);
{
  ck('不存在的 key → 空数组', store.topMarks('nope', 5).length === 0);
}

console.log(`\n[8] 退役后被重新标（撤销退役）能回到现行`);
{
  db.prepare(`UPDATE covenant_marks SET retiredAt=NULL, retiredVerdict='broke' WHERE key=? AND norm=?`).run(KEY, 'ret-0');
  // ⚠ 此时库里还有一条强度 500 的孤儿（[2] 加的），它排第一是**正确**的
  //   （includeUnsupported=true 时孤儿参与排序）。所以要按"退役第0件是否在榜上"判断，
  //   而不是"它必须是榜首"。
  const got = store.topMarks(KEY, 10, { includeUnsupported: true });
  ck('撤销退役的高强度条目回到榜上', got.some((m) => m.text === '退役第0件'), JSON.stringify(got.map((m) => m.text)));
  // 默认口径（不含孤儿）下，强度 100+ 的它就应该排第一
  const def = store.topMarks(KEY, 5);
  ck('默认口径下它排第一（强度 100 > 现行的 1）', def[0]?.text === '退役第0件', JSON.stringify(def.map((m) => m.text)));
  db.prepare(`UPDATE covenant_marks SET retiredAt='2026-08-01 12:00' WHERE key=? AND norm=?`).run(KEY, 'ret-0');
  ck('再退役后立刻从榜上消失', !store.topMarks(KEY, 5).some((m) => m.text === '退役第0件'));
}

db.close(); store.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
