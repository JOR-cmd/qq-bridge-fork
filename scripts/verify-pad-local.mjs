// 只读验证：新的 PAD 实现 vs memory-brain 原版词表，对比命中率与误判。
//
// 目的：实现前先量化确认「本地化词表」确实比原版好，
// 否则就是凭感觉改代码（这个项目反复踩过的坑）。
import { DatabaseSync } from 'node:sqlite';
import { RULES, appraise, apply, emptyPad, describe, regulation, hint, topLabel } from '../src/emotion-pad.mjs';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);

// ── ① 词表覆盖对比 ────────────────────────────────────────────────────
// 原版 10 条（用来对比）—— 直接从参考实现抄，只用于统计
const ORIGINAL = [
  ['开心', ['哈哈', '笑死', '好笑', '可爱', '喜欢', '好棒', '厉害', '开心']],
  ['生气', ['滚', '闭嘴', '蠢', '笨', '烦死', '骗子', '敷衍', '讨厌']],
  ['难过', ['难过', '伤心', '哭', '失落', '走了', '再见']],
  ['害怕', ['吓', '怕', '危险', '恐怖', '报警']],
  ['委屈', ['不理', '冷落', '冤枉', '嫌', '不公']],
  ['害羞', ['脸红', '害羞', '别说了', '讨厌啦']],
  ['得意', ['我厉害', '赢了', '夸我', '聪明']],
  ['感动', ['谢谢', '心疼', '抱抱', '陪我', '记得']],
  ['焦虑', ['来不及', '怎么办', '担心', '怕错过']],
  ['无聊', ['无聊', '没意思', '好闲']],
];

const countOriginal = () => {
  let n = 0;
  for (const r of rows) {
    const t = String(r.text || '');
    for (const [, words] of ORIGINAL) if (words.some((w) => t.includes(w))) n += 1;
  }
  return n;
};

// 新版用 appraise()
let newHit = 0;
const byLabelNew = {};
for (const r of rows) {
  for (const [label] of appraise(r.text)) {
    newHit += 1;
    byLabelNew[label] = (byLabelNew[label] || 0) + 1;
  }
}

const origHit = countOriginal();
console.log('=== ① 词表覆盖对比（896 条真实消息）===');
console.log(`原版词表命中的消息数  : ${countOriginal()} 次`);
console.log(`本地化词表命中         : ${newHit} 次`);
console.log(`提升                   : ${((newHit / Math.max(1, countOriginal()) - 1) * 100).toFixed(0)}%`);
console.log();
console.log('本地化各标签命中:');
for (const [k, v] of Object.entries(byLabelNew).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(4)} ${String(v).padStart(3)}`);
}

// ── ② 模拟真实时间线（看情绪状态是否真的会变化）────────────────────────
console.log();
console.log('=== ② 按真实时间线模拟，最后情绪状态 ===');
let pad = emptyPad(new Date(rows[0]?.t || Date.now()).getTime());
let changed = 0;
for (const r of rows) {
  const before = JSON.stringify(pad.labels);
  pad = apply(pad, r.text, Number(r.t));
  if (JSON.stringify(pad.labels) !== before) changed += 1;
}
console.log(`状态发生变化的次数: ${changed} / ${rows.length}`);
console.log(`最终 PAD: p=${pad.p.toFixed(2)} a=${pad.a.toFixed(2)} d=${pad.d.toFixed(2)}`);
console.log(`最终标签: ${JSON.stringify(pad.labels)}`);
console.log(`describe() → 「${describe(pad)}」`);
console.log(`hint()     → 「${hint(pad)}」`);
console.log(`regulation() → ${regulation(pad, Date.now()) ? '有' : '无'}`);

// ── ③ 误判抽查 ────────────────────────────────────────────────────────
console.log();
console.log('=== ③ 误判抽查（人工核对用）===');
const samples = rows.filter((r) => /陪我|讨厌啦|失忆|唉/.test(String(r.text))).slice(0, 10);
for (const r of samples) {
  const hits = appraise(r.text);
  console.log(`  ${r.side === 'her' ? '她' : '他'}：「${String(r.text).slice(0, 34)}」`);
  console.log(`     → ${hits.length ? hits.map(([l]) => l).join(', ') : '（无）'}`);
}
db.close();
