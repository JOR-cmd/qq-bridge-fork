// 测：向量检索能不能解决"图谱也解决不了"的那类查询？
//
// 关键区分：
//   · 图谱擅长：给出实体名 → 扩散出整组相关对话（但需要先有种子）
//   · 向量擅长：换了说法、没有共同关键词 → 靠语义接近找
//
// 上一轮测出 FTS 只有 55% 命中。看那 45% 失败的到底是什么类型。
import { DatabaseSync } from 'node:sqlite';
import { recallSnippets } from '../src/recall.mjs';

const KEY = 'private:<OWNER_QQ>';
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages where key=? order by t').all(KEY);

// 把 FTS 失败的查询分类
const failed = [
  '那天你说要给我装眼睛',   // 跨消息的语义关联
  '你催我去洗澡',           // 主谓结构，关键词「洗澡」但加了「催我」
  '熬夜到几点',             // 组合词
  '抱着打游戏',             // 「抱」+「游戏」两个词但不在同一句
  '桥接 token',             // 中英混合
  '你陪我洗澡那次',         // 「陪」+「洗澡」
  '催我吹头',               // 口语化
  '我不吃香菜',             // 从没提过（测试负例）
];

console.log('=== FTS 失败的 8 个查询，逐个分析失败原因 ===');
for (const q of failed) {
  const h = recallSnippets({ dbPath: 'state/archive.db', key: KEY, query: q, before: Date.now(), limit: 3, minHits: 2, maxChars: 60 });
  // 拆词看每个词在库里有没有
  const words = q.split(/[\s]+/).filter(Boolean);
  console.log();
  console.log(`「${q}」→ FTS ${h.length} 条`);
  // 检查库里是否真的有相关内容
  const keywords = [];
  if (/眼睛/.test(q)) keywords.push('眼睛');
  if (/洗澡/.test(q)) keywords.push('洗澡');
  if (/游戏/.test(q)) keywords.push('游戏');
  if (/吹头/.test(q)) keywords.push('吹头');
  if (/香菜/.test(q)) keywords.push('香菜');
  if (/桥接|token/.test(q)) keywords.push('桥接');
  for (const k of keywords) {
    const n = rows.filter((r) => String(r.text).includes(k)).length;
    console.log(`   关键词「${k}」在库里出现 ${n} 次`);
  }
}

console.log();
console.log('=== 结论性判断 ===');
console.log('如果"关键词在库里出现多次但 FTS 查不到"，说明问题在**分词/门槛**，不是语义。');
console.log('如果"关键词一次都没出现"，才是真正的语义缺口（需要向量）。');
db.close();
