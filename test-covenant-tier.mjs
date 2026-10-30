// 记忆分层回归（**先写测试，再改实现**）。
// 用法：node test-covenant-tier.mjs
//
// 锁住 2026-10-30 查出来的漏洞 E：
//   `covenant_marks.tier` 有默认值 'L4'、decay-memory.mjs 也有 HALF_LIFE={L1:30,L2:180,L3:90}，
//   但**代码里没有任何地方能写 tier** —— 全库永远是 L4，
//   于是 decay-memory 的 marks 段恒为「L4 锚豁免: N 条 / 参与衰减: 0 条」，
//   那套半衰期一行都没执行过（五级遗忘里整整一层是死代码）。
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-tier-'));
const DB = path.join(dir, 'archive.db');
const KEY = 'private:10001';
const store = new CovenantStore(DB);
const byText = (t) => store.topMarks(KEY, 50, { includeUnsupported: true }).find((m) => m.text === t);

// ── 1. 默认仍然是 L4（不能把现有行为改坏）────────────────────────────────
console.log('\n[1] 默认 L4（她的标记几乎全是关系/约定，本来就该是锚）');
{
  store.addMark(KEY, '默认那条', '2026-10-20');
  const m = byText('默认那条');
  ck('不传 tier → L4', m && m.tier === 'L4', m && m.tier);
}

// ── 2. 显式 tier 必须真的落库 ─────────────────────────────────────────
console.log('\n[2] 显式传 tier 必须被存下来（否则半衰期永远是死代码）');
{
  for (const tier of ['L1', 'L2', 'L3', 'L4']) {
    const text = `层级测试 ${tier}`;
    store.addMark(KEY, text, '2026-10-20', tier);
    const m = byText(text);
    ck(`传 '${tier}' → 读回 '${tier}'`, m && m.tier === tier, m && m.tier);
  }
}

// ── 3. 非法值回落 L4（不能写进去一个不存在的层级）───────────────────────
console.log('\n[3] 非法 tier 一律回落 L4');
{
  // 'l3 '（带空格）刻意也算非法 —— 白名单是精确匹配，不做 trim。
  // 如果想让它通过，请在 covenant-store 里显式 trim，而不是放宽测试。
  for (const bad of ['L9', 'l3 ', 'anchor', '', null, undefined, 123, {}, []]) {
    const label = JSON.stringify(bad) ?? String(bad);
    const text = `非法值 ${label}`;
    store.addMark(KEY, text, '2026-10-20', bad);
    const m = byText(text);
    ck(`${label} → L4`, m && m.tier === 'L4', m && m.tier);
  }
  // 大小写不敏感是允许的（'l3' 应该被接受成 'L3'）
  store.addMark(KEY, '小写 l3', '2026-10-20', 'l3');
  const low = byText('小写 l3');
  ck("小写 'l3' → 'L3'（大小写不敏感）", low && low.tier === 'L3', low && low.tier);
}

// ── 4. 真实数据里现在应该能分出非锚的层级了 ─────────────────────────────
console.log('\n[4] 库里必须出现非 L4 的标记（这是"那层不再是死代码"的直接证据）');
{
  const all = store.topMarks(KEY, 50, { includeUnsupported: true });
  const tiers = {};
  for (const m of all) tiers[m.tier] = (tiers[m.tier] || 0) + 1;
  const nonAnchor = all.filter((m) => m.tier !== 'L4').length;
  ck('存在 L1/L2/L3 的标记', nonAnchor > 0, JSON.stringify(tiers));
  ck('L4 仍在（默认没被冲掉）', (tiers.L4 || 0) > 0, JSON.stringify(tiers));
}

// ── 5. 衰减脚本真的会为这些标记算出衰减 ─────────────────────────────────
console.log('\n[5] 端到端：decay-memory 的 marks 段不再恒为「参与衰减 0 条」');
{
  // 直接复用脚本里的公式，确认 L1/L2/L3 会得到 < 原值的衰减结果
  const HALF_LIFE = { L1: 30, L2: 180, L3: 90 };
  const DAY = 86400000;
  const now = Date.now();
  const marks = store.topMarks(KEY, 50, { includeUnsupported: true }).filter((m) => m.tier !== 'L4');
  ck('有非锚标记可参与衰减', marks.length > 0, `${marks.length}`);
  let decayed = 0;
  for (const m of marks) {
    const ageDays = Math.max(0, (now - Date.parse(`${m.lastDay}T00:00:00`)) / DAY);
    const next = Math.max(0.02, Number(m.strength) * Math.pow(2, -ageDays / HALF_LIFE[m.tier]));
    if (next < Number(m.strength)) decayed += 1;
  }
  ck('按半衰期算出来的值确实小于原 strength（说明公式接上了）', decayed > 0, `decayed=${decayed}/${marks.length}`);
}

store.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
