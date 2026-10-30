// 验证：把 minHits 门槛调对，能不能解决那 7 个"其实有内容却查不到"的查询。
//
// 上一轮的关键发现：8 个失败查询里，7 个的关键词在库里真实存在。
// 说明问题不是"语义鸿沟"，而是**门槛算法把长查询判死了**。
//
// 现有门槛（recall.mjs:90）：
//   need = max(1, min(tokens >= 4 ? 3 : 2, tokens.length))
//   「你陪我洗澡那次」→ tokens 可能 4+ 个 → need=3 → 要求同时命中 3 个词
//   但那条消息里可能只有「洗澡」一个词 → 永远不命中
import { DatabaseSync } from 'node:sqlite';
import { recallSnippets, queryTokens, stripWhenWords } from '../src/recall.mjs';
import { parseWhen, dayOf } from '../src/when-cn.mjs';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const now = Date.now();

const queries = [
  '那天你说要给我装眼睛',
  '你催我去洗澡',
  '抱着打游戏',
  '桥接 token',
  '你陪我洗澡那次',
  '催我吹头',
  '熬夜到几点',
  '我不吃香菜',
];

console.log('=== 每个查询的分词结果与门槛 ===');
for (const q of queries) {
  const tokens = queryTokens(q);
  const need = Math.max(1, Math.min(tokens.length >= 4 ? 3 : 2, tokens.length));
  console.log(`「${q}」`);
  console.log(`   tokens(${tokens.length}): ${JSON.stringify(tokens)}`);
  console.log(`   need=${need} → 要求一条消息里同时出现 ${need} 个词`);
}

console.log();
console.log('=== 不同门槛下的命中数 ===');
console.log('查询'.padEnd(20), 'need=3', 'need=2', 'need=1');
for (const q of queries) {
  const r3 = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: now, limit: 3, minHits: 3, maxChars: 60 });
  const r2 = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: now, limit: 3, minHits: 2, maxChars: 60 });
  const r1 = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: now, limit: 3, minHits: 1, maxChars: 60 });
  console.log(
    q.slice(0, 18).padEnd(20),
    String(r3.length).padStart(6),
    String(r2.length).padStart(6),
    String(r1.length).padStart(6),
  );
}

console.log();
console.log('=== 关键：need=1 会不会带回噪声？抽样看 ===');
for (const q of ['你陪我洗澡那次', '抱着打游戏', '我不吃香菜']) {
  const h = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: now, limit: 3, minHits: 1, maxChars: 60 });
  console.log(`「${q}」→ ${h.length} 条`);
  for (const x of h) console.log(`   [${x.score?.toFixed(2)}] ${String(x.text).slice(0, 40)}`);
}
db.close();
