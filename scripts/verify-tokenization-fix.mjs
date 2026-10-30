// 验证：把 queryTokens 从"步长2"改成"滑动1"后，检索命中率提升多少。
//
// 这是**不改源码**的对照实验：用同样的 store.search，只换分词函数。
import { DatabaseSync } from 'node:sqlite';
import { ArchiveStore } from '../src/archive-store.mjs';
import { queryTokens } from '../src/recall.mjs';

const KEY = 'private:<OWNER_QQ>';
const now = Date.now();

/** 候选修法：长句用滑动的 2-gram（步长 1），这样「洗澡」不会被切碎 */
function slidingTokens(text) {
  const out = new Set();
  for (const run of String(text ?? '').match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 4) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const word of String(text ?? '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) out.add(word);
  return [...out].slice(0, 12);
}

const queries = [
  '你陪我洗澡那次', '抱着打游戏', '那天你说要给我装眼睛', '熬夜到几点',
  '你催我去洗澡', '桥接 token', '催我吹头', '上次打游戏打到第几把',
  '方舟前瞻', '精神寄托', '想你了', '洗澡',
];

const store = new ArchiveStore('state/archive.db');
const run = (tokensFn, q, need) => {
  const tokens = tokensFn(q);
  if (!tokens.length) return [];
  const needN = Math.max(1, Math.min(tokens.length >= 4 ? 3 : 2, tokens.length));
  const effectiveNeed = Number.isFinite(need) ? need : needN;
  return store.search({ key: KEY, tokens, before: now, limit: 3, minHits: effectiveNeed });
};

console.log('=== 分词方式对比（同样 minHits 门槛）===');
console.log('查询'.padEnd(20), '步长2', '滑动1', '增益');
let a = 0; let b = 0;
for (const q of queries) {
  const old = run(queryTokens, q);
  const neu = run(slidingTokens, q);
  if (old.length) a += 1;
  if (neu.length) b += 1;
  const mark = (old.length === 0 && neu.length > 0) ? '← 救回' : '';
  console.log(q.slice(0, 18).padEnd(20), String(old.length).padStart(5), String(neu.length).padStart(6), mark);
}
console.log();
console.log(`命中数: 步长2 ${a}/${queries.length} → 滑动1 ${b}/${queries.length}`);
console.log(`提升: +${b - a} 个（${((b - a) / queries.length * 100).toFixed(0)} 个百分点）`);

console.log();
console.log('=== 重要：滑动1 会不会带来噪声？（看救回的那几条质量）===');
for (const q of queries) {
  const old = run(queryTokens, q);
  const neu = run(slidingTokens, q);
  if (old.length === 0 && neu.length > 0) {
    console.log(`「${q}」`);
    for (const x of neu.slice(0, 2)) console.log(`   → ${String(x.text).slice(0, 50)}`);
  }
}
store.close();
