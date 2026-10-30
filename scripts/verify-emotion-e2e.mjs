// 只读端到端验证：模拟桥的完整情绪链路。
//
// 验证四件事：
//   ① 收消息 → 情绪更新（applyEmotionV2 的等价流程）
//   ② 唤醒时 → 衰减后再读（不会读到过期情绪）
//   ③ 提示词段 → 有情绪才出现，没情绪不占预算
//   ④ 边界 → 坏数据、空状态、长间隔都不崩
//
// 不启桥、不写真实 state/。
import { DatabaseSync } from 'node:sqlite';
import {
  apply as applyPad, decay as decayPad, describe as describePad,
  regulation as regulationPad, hint as hintPad, emptyPad,
} from '../src/emotion-pad.mjs';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? and side=? order by t').all(KEY, 'him');

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

// 复刻 bridge.js 的 buildEmotionLineV2
function buildEmotionLine(pad, now) {
  const p = decayPad(pad ?? emptyPad(now), now);
  const desc = describePad(p);
  if (!desc) return { line: '', pad: p };
  const hint = hintPad(p);
  const reg = regulationPad(p, now);
  const lines = [`【此刻的你】${desc}`];
  if (hint) lines.push(`怎么说：${hint}。`);
  if (reg) lines.push(reg);
  lines.push('（这只是你此刻的心情，不影响你该做的事：照常看消息、照常收尾。）');
  return { line: `${lines.join('\n')}\n\n`, pad: p };
}

console.log('\n[1] 端到端：按他的真实消息顺序跑一遍');
{
  let pad = emptyPad(Number(rows[0].t));
  let withEmotion = 0;
  const examples = [];
  for (const r of rows) {
    pad = applyPad(pad, r.text, Number(r.t));
    const { line } = buildEmotionLine(pad, Number(r.t));
    if (line) {
      withEmotion += 1;
      if (examples.length < 5) examples.push({ text: r.text.slice(0, 30), line: line.split('\n')[0] });
    }
  }
  ck(`跑完 ${rows.length} 条不抛异常`, true);
  console.log(`     有情绪段的比例: ${withEmotion}/${rows.length} = ${(withEmotion / rows.length * 100).toFixed(0)}%`);
  console.log('     样例:');
  for (const e of examples) console.log(`       「${e.text}」→ ${e.line}`);
  ck('不是每条都有情绪段（否则等于没筛选）', withEmotion < rows.length);
  ck('也不是完全没有（否则功能是摆设）', withEmotion > 0);
}

console.log('\n[2] 长间隔后唤醒：情绪应该已衰减');
{
  const t0 = 1_700_000_000_000;
  let pad = emptyPad(t0);
  pad = applyPad(pad, '我好委屈，你怎么不理我', t0);
  const before = describePad(pad);
  ck('刚说完有情绪', before.length > 0, before);
  // 6 小时后唤醒
  const { line } = buildEmotionLine(pad, t0 + 6 * 3600 * 1000);
  ck('6 小时后情绪已淡（不超过阈值就不出现）', line === '' || !line.includes('委屈'), line.slice(0, 60));
}

console.log('\n[3] 边界：坏数据不崩');
{
  for (const bad of [null, undefined, {}, { labels: null }, { labels: 'x' }, { at: 'abc' }]) {
    try {
      const { line } = buildEmotionLine(bad, Date.now());
      ck(`坏状态 ${JSON.stringify(bad)} 不抛`, true);
    } catch (e) {
      ck(`坏状态 ${JSON.stringify(bad)} 不抛`, false, e.message);
    }
  }
}

console.log('\n[4] 提示词段的字数（不能占太多预算）');
{
  const t0 = Date.now();
  let pad = emptyPad(t0);
  pad.labels['委屈'] = 0.5;
  pad.trigger = '他说我说话像机器';
  pad.soothedAt = t0 - 60_000;
  const { line } = buildEmotionLine(pad, t0);
  const chars = [...line].length;
  console.log(`     实际字数: ${chars}`);
  console.log('     内容:');
  for (const l of line.trim().split('\n')) console.log(`       ${l}`);
  ck('字数合理（<300）', chars < 300, `${chars} 字`);
  ck('含「不影响你该做的事」的护栏', line.includes('不影响你该做的事'));
}

db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
