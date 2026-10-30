// 深挖：图谱到底有没有独特价值？三种可能的测试。
//
// 上一次测量的结论是"图谱救回 0 个"——但那是因为我把图谱定义成
// "FTS 先找种子，再按实体扩散"。如果种子都没有，图谱当然没用。
//
// 真正的疑问：图谱能不能做到 FTS 做不到的事？
//   ① 用户提一个实体名（不带上下文），能带回整组相关对话？
//   ② 跨时间的"同一件事"能不能被串起来？
//   ③ 实体覆盖率 25% 是不是太低？如果不抽名词而是抽"话题"，能到多少？
import { DatabaseSync } from 'node:sqlite';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);

// ── ① 测试：给一个实体名，图谱能带回多少条？────────────────────────
// 这是图谱的"正面用例"：她说「说起洗澡那件事」，不指望关键词匹配，
// 而希望把和洗澡有关的一整段对话都拉出来。
const ENTITY = [
  ['洗澡', /洗澡|冲洗|泡着|浴缸|吹头/],
  ['作业', /作业/],
  ['游戏', /游戏|打游戏|方舟|塔露拉/],
  ['眼睛', /眼睛|装眼睛|看着我|看清/],
  ['表情包', /表情|表情包/],
  ['熬夜', /熬夜|几点|困|躺|睡/],
];

const tagged = rows.map((r) => ({
  ...r,
  ents: ENTITY.filter(([, re]) => re.test(String(r.text))).map(([n]) => n),
}));

console.log('=== ① 给一个实体名，能带回多少条 ===');
console.log('实体    消息数   时间跨度          密集度(每小时几条)');
for (const [name] of ENTITY) {
  const hit = tagged.filter((r) => r.ents.includes(name));
  if (!hit.length) { console.log(`${name.padEnd(6)} 0`); continue; }
  const spanH = (Number(hit[hit.length - 1].t) - Number(hit[0].t)) / 3600000;
  const density = spanH > 0 ? (hit.length / spanH).toFixed(1) : 'N/A';
  console.log(
    `${name.padEnd(6)} ${String(hit.length).padStart(5)}   ` +
    `${spanH.toFixed(0).padStart(5)} 小时(${(spanH / 24).toFixed(1)}天)   ${density}`,
  );
}

// ── ② 测试：跨时间同一件事能不能串起来 ───────────────────────────
console.log();
console.log('=== ② 「洗澡」这个话题在不同天出现过吗（跨时间串联的前提）===');
const wash = tagged.filter((r) => r.ents.includes('洗澡'));
const byDay = {};
for (const r of wash) {
  const d = new Date(Number(r.t)).toISOString().slice(0, 10);
  byDay[d] = (byDay[d] || 0) + 1;
}
for (const [d, n] of Object.entries(byDay).sort()) console.log(`  ${d}: ${n} 条`);

console.log();
console.log('=== ③ 如果抽"话题"而不是"实体"，覆盖率能到多少 ===');
// 放宽：只要有中文内容就算一条可用消息（不要求命中固定实体表）
const anyTopic = rows.filter((r) => /[\u4e00-\u9fff]/.test(String(r.text)));
console.log(`固定实体表（6 个话题）: 覆盖 ${tagged.filter((r) => r.ents.length > 0).length}/${rows.length} = ${(tagged.filter((r) => r.ents.length > 0).length / rows.length * 100).toFixed(0)}%`);
console.log(`有中文内容:              ${anyTopic.length}/${rows.length} = ${(anyTopic.length / rows.length * 100).toFixed(0)}%`);

// ── ④ 关键判断：图谱 vs 直接放宽 FTS 门槛 ─────────────────────────
console.log();
console.log('=== ④ 图谱的增益，能不能用"放宽 FTS 门槛"替代？===');
console.log('（如果放宽门槛就能达到同样效果，图谱就不必要）');

const { recallSnippets } = await import('../src/recall.mjs');
const tests = ['上次打游戏打到第几把', '方舟前瞻', '作业拖到明天'];
console.log('查询'.padEnd(22), 'minHits=2', 'minHits=1', '图谱扩散');
for (const q of tests) {
  const strict = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: Date.now(), limit: 3, minHits: 2, maxChars: 60 });
  const loose = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: Date.now(), limit: 3, minHits: 1, maxChars: 60 });
  // 图谱：用宽松结果做种子，再扩散
  const seedEnts = new Set();
  for (const s of loose) {
    for (const r of tagged) if (Number(r.t) === Number(s.t)) r.ents.forEach((e) => seedEnts.add(e));
  }
  const expand = tagged.filter((r) => r.ents.some((e) => seedEnts.has(e))).length;
  console.log(q.padEnd(22), String(strict.length).padStart(9), String(loose.length).padStart(9), String(expand).padStart(9));
}

db.close();
