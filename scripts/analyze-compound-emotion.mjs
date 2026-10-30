// 只读分析：改成"显示复合情绪"后，实际会显示什么。
//
// 回答的问题：改 describe() 到底会带来什么变化，噪声有多大。
import { DatabaseSync } from 'node:sqlite';
import { appraise, apply, emptyPad, topLabel, describe, RULES } from '../src/emotion-pad.mjs';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);

console.log('=== ① 命中 2 个标签的消息有多少 ===');
let multi = 0; let single = 0; let zero = 0;
for (const r of rows) {
  const n = appraise(r.text).length;
  if (n === 0) zero += 1;
  else if (n === 1) single += 1;
  else multi += 1;
}
console.log(`  0 个: ${zero} 条 (${(zero / rows.length * 100).toFixed(0)}%)`);
console.log(`  1 个: ${single} 条 (${(single / rows.length * 100).toFixed(0)}%)`);
console.log(`  2 个: ${multi} 条 (${(multi / rows.length * 100).toFixed(0)}%)`);
console.log(`  → 能显示复合的只占 ${(multi / rows.length * 100).toFixed(0)}%`);

console.log();
console.log('=== ② 模拟完整时间线：混合情绪的强度关系 ===');
// 按真实时间顺序跑，记录每次 describe 时主/次标签的比例
let pad = emptyPad(Number(rows[0].t));
const ratios = [];
const examples = [];
for (const r of rows) {
  pad = apply(pad, r.text, Number(r.t));
  const labels = pad.labels;
  const names = Object.keys(labels).sort((a, b) => labels[b] - labels[a]);
  if (names.length < 2) continue;
  const primary = labels[names[0]];
  const second = labels[names[1]];
  if (primary < 0.12) continue;
  ratios.push(second / primary);
  if (examples.length < 10) {
    examples.push({ text: r.text.slice(0, 30), names: names.slice(0, 2), primary, second, ratio: second / primary });
  }
}

console.log(`  有 ≥2 个标签且主项够强的时刻: ${ratios.length} 次`);
if (ratios.length) {
  ratios.sort((a, b) => a - b);
  const q = (f) => (ratios[Math.floor(ratios.length * f)] * 100).toFixed(0);
  console.log(`  次/主 比例分布: p25 ${q(0.25)}% | 中位 ${q(0.5)}% | p75 ${q(0.75)}% | p90 ${q(0.9)}%`);
  const strong = ratios.filter((x) => x >= 0.4).length;
  console.log(`  比例 ≥40%（改法B 的门槛）: ${strong} 次 = ${(strong / ratios.length * 100).toFixed(0)}%`);
}

console.log();
console.log('=== ③ 实际会看到的显示差异 ===');
for (const e of examples) {
  const level = (s) => (s < 0.3 ? '有点' : (s < 0.5 ? '挺' : '很'));
  const now = `【现在】${level(e.primary)}${e.names[0]}（${e.primary.toFixed(1)}）`;
  const b = `【改法B】${e.ratio >= 0.4 ? `又${level(e.second)}${e.names[1]}（${e.second.toFixed(1)}）` : '（不显示次要）'}`;
  console.log(`  「${e.text}」`);
  console.log(`     ${now}  →  ${b}  [次/主=${(e.ratio * 100).toFixed(0)}%]`);
}

db.close();
