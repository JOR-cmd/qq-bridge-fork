// 标记排序回归（**先写测试，再改实现**）。
// 用法：node test-covenant-mark-order.mjs
//
// 锁住 2026-10-30 查出来的漏洞 F：
//   `covenant_marks.last_access` 有读（topMarks 的 ORDER BY 第一关键字）但**几乎没写**：
//     · INSERT 时不写 → 新标记落默认值 0
//     · 同一天重标时不写（只 UPDATE text）
//     · touchMarkAccess() 定义了，全仓零调用
//   结果：实测 11 条标记里 7 条 last_access 是**同一个时刻**，排序退化成 strength/lastDay。
//   和项目笔记里记的旧漏洞 ⑤ 是同一个形状（那时是"刷太多次"，现在是"几乎不刷"）。
//
// ⚠️ 用临时库，**不碰真实 state/**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CovenantStore } from './src/covenant-store.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-order-'));
const DB = path.join(dir, 'archive.db');
const KEY = 'private:10001';
const store = new CovenantStore(DB);

const topPlus = (n = 10) => store.topMarks(KEY, n, { includeUnsupported: true });
const markByText = (text) => topPlus(50).find((m) => m.text === text);

// ── 1. 新建标记必须带"创建时刻"打 last_access ─────────────────────────
console.log('\n[1] 新建标记的 last_access 不能是 0');
{
  const t0 = Date.now();
  store.addMark(KEY, '第一件事：他说不会嫌我', '2026-10-20');
  const m = markByText('第一件事：他说不会嫌我');
  ck('新建后有这条标记', !!m, JSON.stringify(topPlus().map((x) => x.text)));
  ck('lastAccess > 0（不是默认值 0）', m && m.lastAccess > 0, `lastAccess=${m && m.lastAccess}`);
  ck('lastAccess 落在合理区间（就是刚才）', m && m.lastAccess >= t0 - 5000 && m.lastAccess <= Date.now() + 5000, `lastAccess=${m && m.lastAccess}`);
}

// ── 2. 不同时间建的标记，last_access 必须能区分先后 ─────────────────────
console.log('\n[2] 连建三条，last_access 必须严格递增（排序才有意义）');
{
  store.addMark(KEY, '第二件事：你陪着就已经够了', '2026-10-21');
  await new Promise((r) => setTimeout(r, 30));
  store.addMark(KEY, '第三件事：你会失忆吗', '2026-10-22');
  await new Promise((r) => setTimeout(r, 30));
  store.addMark(KEY, '第四件事：我可不舍得', '2026-10-23');

  const a = markByText('第二件事：你陪着就已经够了');
  const b = markByText('第三件事：你会失忆吗');
  const c = markByText('第四件事：我可不舍得');
  ck('三条都在', a && b && c);
  ck('a < b 的 lastAccess', a && b && a.lastAccess < b.lastAccess, `${a && a.lastAccess} vs ${b && b.lastAccess}`);
  ck('b < c 的 lastAccess', b && c && b.lastAccess < c.lastAccess, `${b && b.lastAccess} vs ${c && c.lastAccess}`);

  // topMarks 的第一关键字是 last_access DESC → 最新的排最前
  const order = topPlus(3).map((m) => m.text);
  ck('topMarks 第一条是最后建的那条', order[0] === '第四件事：我可不舍得', JSON.stringify(order));
}

// ── 3. 同一天重标：强度不涨，但 last_access 要跟着前进 ──────────────────
console.log('\n[3] 同一天重标：strength 不变、last_access 前进');
{
  const before = markByText('第一件事：他说不会嫌我');
  await new Promise((r) => setTimeout(r, 30));
  store.addMark(KEY, '第一件事：他说不会嫌我', '2026-10-20');   // 同一天
  const after = markByText('第一件事：他说不会嫌我');
  ck('strength 没涨（同一天不算两天）', after && after.strength === 1, `strength=${after && after.strength}`);
  ck('lastAccess 前进了', after && after.lastAccess > before.lastAccess, `${before.lastAccess} → ${after && after.lastAccess}`);
}

// ── 4. 跨天重标：强度 +1，且 last_access 前进 ───────────────────────────
console.log('\n[4] 跨天重标：strength +1 且 last_access 前进');
{
  const before = markByText('第二件事：你陪着就已经够了');
  await new Promise((r) => setTimeout(r, 30));
  store.addMark(KEY, '第二件事：你陪着就已经够了', '2026-10-24');   // 不同天
  const after = markByText('第二件事：你陪着就已经够了');
  ck('strength 涨到 2', after && after.strength === 2, `strength=${after && after.strength}`);
  ck('lastAccess 前进了', after && after.lastAccess > before.lastAccess);
  ck('lastDay 更新到 2026-10-24', after && after.lastDay === '2026-10-24', after && after.lastDay);
}

// ── 5. touchMarkAccess 本身可用（它现在是唯一的"手动提起"入口）──────────
console.log('\n[5] touchMarkAccess 可用');
{
  const before = markByText('第三件事：你会失忆吗');
  const n = store.touchMarkAccess(KEY, [before.norm], Date.now() + 1000);
  ck('返回受影响行数 1', n === 1, `n=${n}`);
  const after = markByText('第三件事：你会失忆吗');
  ck('lastAccess 被推进', after && after.lastAccess > before.lastAccess, `${before.lastAccess} → ${after && after.lastAccess}`);
  ck('strength 不动（只是"提了一下"，不是重新标）', after && after.strength === 1, `strength=${after && after.strength}`);
  ck('传空数组安全', store.touchMarkAccess(KEY, []) === 0);
  ck('传垃圾值安全', store.touchMarkAccess(KEY, [null, undefined, 123]) === 0);
}

store.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
