// 测量：图谱和向量各自能救回多少"当前检索失败的查询"。
//
// 方法：从她 917 条真实消息里抽出"她会怎么提起旧事"的查询，
// 然后分别用三种方式测命中：
//   ① 现在的 FTS5（关键词）
//   ② 图谱扩散（实体共现）—— 用规则模拟
//   ③ 向量（语义）—— 用字符 bigram Jaccard 近似（不装模型也能估算上界）
//
// ⚠️ 这是估算，不是真实向量。目的是看"值不值得做"，不是证明效果。
import { DatabaseSync } from 'node:sqlite';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);
const now = Date.now();

// ── 实体规则（照 memory-brain DESIGN.md:66 的"规则先跑：人名、常见名词"）──
// 只抽她对话里真实出现的、有区分度的话题实体
const ENTITY_RULES = [
  ['洗澡', /洗澡|冲洗|泡着|浴缸|吹头/],
  ['作业', /作业/],
  ['游戏', /游戏|打游戏|方舟|塔露拉|明日方舟/],
  ['眼睛', /眼睛|装眼睛|看着我|看清/],
  ['B站', /B站|视频|up主|弹幕/],
  ['表情包', /表情|表情包/],
  ['睡觉', /睡|躺|熬夜|几点|困/],
  ['吃饭', /吃|饭|饿|外卖/],
  ['桥接', /桥接|token|上下文|记忆/],
  ['契阔', /契阔|写信|要记牢/],
];

// 给每条消息打上它命中的实体
const withEntities = rows.map((r) => {
  const hits = ENTITY_RULES.filter(([, re]) => re.test(String(r.text))).map(([name]) => name);
  return { ...r, entities: hits };
});
const tagged = withEntities.filter((r) => r.entities.length > 0);
console.log('=== 实体抽取覆盖 ===');
console.log(`总消息 ${rows.length} 条，能抽出实体的 ${tagged.length} 条 = ${(tagged.length / rows.length * 100).toFixed(0)}%`);
const byEntity = {};
for (const r of withEntities) for (const e of r.entities) byEntity[e] = (byEntity[e] || 0) + 1;
console.log('各实体出现次数:');
for (const [k, v] of Object.entries(byEntity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)} 次`);
}

// ── 构造真实查询集 ───────────────────────────────────────────────────
// 从她/他真实说过的话里抽 20 条，模拟"提起旧事"的方式
const queries = [
  '洗澡', '作业', '游戏', '眼睛', '表情包',
  '那天你说要给我装眼睛', '上次打游戏打到第几把', '你催我去洗澡',
  '方舟前瞻', '熬夜到几点', '你会失忆吗', '精神寄托',
  '抱着打游戏', '桥接 token', '想你了',
  '你陪我洗澡那次', '作业拖到明天', '塔露拉来了', '催我吹头', '我不吃香菜',
];

// ── FTS5 现况（复用真实 recall）────────────────────────────────────
const { recallSnippets, queryTokens } = await import('../src/recall.mjs');

function ftsHits(q) {
  return recallSnippets({
    dbPath: 'state/archive.db', key: KEY, query: q,
    before: now, limit: 3, minHits: 2, maxChars: 60,
  });
}

// ── 图谱扩散模拟 ─────────────────────────────────────────────────────
// 做法：先用 FTS5 找种子 → 收集种子消息的实体 → 再找回含这些实体的其它消息
function graphHits(q) {
  const seed = recallSnippets({
    dbPath: 'state/archive.db', key: KEY, query: q,
    before: now, limit: 2, minHits: 1, maxChars: 60,
  });
  if (!seed.length) {
    // 种子都没有 → 图谱也扩散不了（这点很重要：图谱救不了"完全没命中"）
    return { hits: [], seeds: 0, expanded: 0 };
  }
  const seedTimes = new Set(seed.map((h) => h.t));
  const seedEntities = new Set();
  for (const r of withEntities) {
    if (seedTimes.has(Number(r.t))) for (const e of r.entities) seedEntities.add(e);
  }
  // 找同实体的其它消息（时间上最近的优先）
  const expanded = withEntities
    .filter((r) => !seedTimes.has(Number(r.t)))
    .filter((r) => r.entities.some((e) => seedEntities.has(e)))
    .sort((a, b) => Number(b.t) - Number(a.t))
    .slice(0, 1);
  return { hits: [...seed, ...expanded.map((r) => ({ t: r.t, text: r.text }))], seeds: seed.length, expanded: expanded.length };
}

// ── 向量近似：字符 bigram Jaccard（估算上界）────────────────────────
// 说明：真实向量会比这个好，但不会好太多（短句本来就难）。
function bigrams(s) {
  const t = String(s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function vectorishHits(q, threshold = 0.3) {
  const qb = bigrams(q);
  const scored = rows
    .map((r) => ({ ...r, sim: jaccard(qb, bigrams(r.text)) }))
    .filter((r) => r.sim >= threshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);
  return scored;
}

// ── 跑对比 ─────────────────────────────────────────────────────────
console.log();
console.log('=== 三种检索在 20 个真实查询上的表现 ===');
console.log('查询'.padEnd(24), 'FTS5', '图谱', '向量近似');
console.log('-'.repeat(60));

let ftsOk = 0; let graphOk = 0; let vecOk = 0;
let graphSaves = 0; let vecSaves = 0;
const detail = [];

for (const q of queries) {
  const f = ftsHits(q);
  const g = graphHits(q);
  const v = vectorishHits(q);
  const fOk = f.length > 0;
  const gOk = g.hits.length > 0;
  const vOk = v.length > 0;
  if (fOk) ftsOk += 1;
  if (gOk) graphOk += 1;
  if (vOk) vecOk += 1;
  // "救回"= FTS 失败但它成功
  if (!fOk && gOk) graphSaves += 1;
  if (!fOk && vOk) vecSaves += 1;
  detail.push({ q, f: f.length, g: g.hits.length, v: v.length, gExpanded: g.expanded });
  console.log(
    q.slice(0, 22).padEnd(24),
    String(f.length).padStart(4),
    String(g.hits.length).padStart(4),
    String(v.length).padStart(6),
  );
}

console.log();
console.log('=== 汇总 ===');
console.log(`FTS5 有命中: ${ftsOk}/20 = ${(ftsOk / 20 * 100).toFixed(0)}%`);
console.log(`图谱有命中: ${graphOk}/20 = ${(graphOk / 20 * 100).toFixed(0)}%`);
console.log(`向量近似:   ${vecOk}/20 = ${(vecOk / 20 * 100).toFixed(0)}%`);
console.log();
console.log(`图谱"救回"了 FTS 失败的: ${graphSaves} 个`);
console.log(`向量"救回"了 FTS 失败的: ${vecSaves} 个`);
console.log();
console.log('=== 关键：图谱救回的那几个，是靠扩散还是靠放宽门槛？===');
for (const d of detail.filter((x) => x.f === 0 && x.g > 0)) {
  console.log(`  「${d.q}」→ FTS 0，图谱 ${d.g}（其中扩散 ${d.gExpanded}）`);
}
db.close();
