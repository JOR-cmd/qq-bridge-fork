// 只读验证：把 memory-brain 的 PAD 规则套在她的真实对话上，看会产生什么情绪状态。
//
// 目的：在实现前先确认这个机制对"没人味"到底有没有用。
// 如果规则几乎不触发，那实现了也是摆设（这是这个项目反复踩过的坑）。
//
// 参考源码：_probe/memory-brain/plugins/astrbot_plugin_persona_state/emotion.py
//   RULES        —— 关键词 → (标签, dP, dA, dD)
//   MAX_STEP     = 0.12  （单条最多改变这么多）
//   LABEL_CAP    = 0.6   （标签强度上限）
//   MASK_THRESHOLD = 0.25（低于这个不注入）
//   LABEL_HALF_LIFE_MIN = 45 分钟
//   MOOD_HALF_LIFE_H = 6 小时
import { DatabaseSync } from 'node:sqlite';

const KEY = 'private:<OWNER_QQ>';

// 逐条照抄 memory-brain 的 RULES（10 条），不做任何"优化"
const RULES = [
  ['开心', ['哈哈', '笑死', '好笑', '可爱', '喜欢', '好棒', '厉害', '开心'], 0.10, 0.02, 0.0],
  ['生气', ['滚', '闭嘴', '蠢', '笨', '烦死', '骗子', '敷衍', '讨厌'], -0.12, 0.10, 0.04],
  ['难过', ['难过', '伤心', '哭', '失落', '走了', '再见'], -0.10, -0.04, -0.03],
  ['害怕', ['吓', '怕', '危险', '恐怖', '报警'], -0.08, 0.12, -0.08],
  ['委屈', ['不理', '冷落', '冤枉', '嫌', '不公'], -0.10, 0.02, -0.07],
  ['害羞', ['脸红', '害羞', '别说了', '讨厌啦'], 0.06, 0.06, -0.04],
  ['得意', ['我厉害', '赢了', '夸我', '聪明'], 0.08, 0.02, 0.06],
  ['感动', ['谢谢', '心疼', '抱抱', '陪我', '记得'], 0.10, -0.02, 0.02],
  ['焦虑', ['来不及', '怎么办', '担心', '怕错过'], -0.06, 0.08, -0.04],
  ['无聊', ['无聊', '没意思', '好闲'], -0.04, -0.06, 0.0],
];

const MAX_STEP = 0.12;
const LABEL_CAP = 0.6;
const MASK_THRESHOLD = 0.25;

const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);

// 模拟：按时间顺序更新情绪状态（简化：不跨天重置，只看整体命中）
let labels = {};
let hits = 0;
const hitByLabel = {};
const examples = [];

for (const r of rows) {
  const text = String(r.text || '');
  for (const [name, words, dp, da, dd] of RULES) {
    const word = words.find((w) => text.includes(w));
    if (!word) continue;
    hits += 1;
    hitByLabel[name] = (hitByLabel[name] || 0) + 1;
    // 简化：只统计，不做真正的 PAD 累加（先看命中率）
    if (examples.length < 12) {
      examples.push({ side: r.side === 'her' ? '她' : '他', word, label: name, text: text.slice(0, 40) });
    }
  }
}

console.log('=== memory-brain 的 10 条情绪规则，在她真实对话上的命中情况 ===');
console.log(`总消息 ${rows.length} 条，规则命中 ${hits} 次`);
console.log();

console.log('=== 各标签命中次数 ===');
const sorted = Object.entries(hitByLabel).sort((a, b) => b[1] - a[1]);
for (const [name, n] of sorted) {
  console.log(`  ${name.padEnd(4)} ${String(n).padStart(3)} 次`);
}
const zero = RULES.map((r) => r[0]).filter((n) => !hitByLabel[n]);
console.log();
console.log('完全没命中的标签:', zero.length ? zero.join(', ') : '（无）');

console.log();
console.log('=== 命中样例 ===');
for (const e of examples) {
  console.log(`  [${e.label}] ${e.side}：「${e.word}」→ ${e.text}`);
}

console.log();
console.log('=== 关键判断 ===');
const hitMsgRatio = hits / rows.length;
console.log(`平均每条消息命中 ${hitMsgRatio.toFixed(2)} 个标签`);
if (hitMsgRatio < 0.2) {
  console.log('⚠️ 命中率低于 20% → 情绪层大部分时候是空的，可能解决不了"没人味"');
} else {
  console.log('✅ 命中率可以，情绪层会有内容');
}
db.close();
