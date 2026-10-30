// 只读：验证运行中的桥加载的是 L1 新代码。
// 两种方式：
//   ① 直接 import 当前磁盘上的代码 —— 证明磁盘版本正确（离线）
//   ② 检查桥日志里新逻辑的痕迹 —— 证明运行时真的用它（在线）
import { recallSnippets, stripWhenWords } from '../src/recall.mjs';
import { parseWhen, dayOf } from '../src/when-cn.mjs';

const today = dayOf(Date.now());
console.log('今天:', today);
console.log();

console.log('=== ① 磁盘代码行为（L1 新逻辑）===');
console.log('解析「上周三」:', JSON.stringify(parseWhen('上周三', today)));
console.log('剥离「作业 前天」:', JSON.stringify(stripWhenWords('作业 前天')));
console.log();

console.log('=== ② 带时间说法 vs 不带（同一内容词，看命中差异）===');
const base = {
  dbPath: 'state/archive.db',
  key: 'private:<OWNER_QQ>',
  before: Date.now(),
  limit: 3,
  minHits: 2,
  maxChars: 200,
};
for (const q of ['作业', '作业 三天前', '作业 昨天', '游戏', '游戏 上周三']) {
  const h = recallSnippets({ ...base, query: q });
  const labels = h.map((x) => x.label).join(' | ') || '(无)';
  console.log(`  ${q.padEnd(14)} → ${h.length} 条  ${labels}`);
}
