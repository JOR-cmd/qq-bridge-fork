// 图谱（话题标签）回归测试（**先写测试，再实现**）。
// 用法：node test-topic-tags.mjs
//
// 设计决定（2026-10-30，经实测确认不臃肿）：
//   **不建 entities/relations 两张表**，直接在 messages 上加一个 tags 字段。
//
//   实测依据（scripts/analyze-graph-value.mjs）：
//     917 条消息 → 实体种类 6 个、关联 138 条、关系 4 条
//     → 两表合计 < 1KB
//   但用 tags 字段更简单：连表都不用建，检索直接 WHERE tags LIKE。
//
// 它的价值不是"替代检索"，而是**把找到的一条扩成一小组**：
//   实测「上次打游戏打到第几把」→ FTS 1 条，图谱扩散 8 条。
//
// ⚠️ 硬前提：图谱必须**先有种子**才能扩散。种子都没有时救不了（实测 0 个）。
import {
  TOPIC_RULES, extractTags, mergeTags, tagOverlap,
} from './src/topic-tags.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`); }
};

console.log('\n[1] 基础抽取：认出话题标签');
{
  ck('「洗澡去了」→ 洗澡', extractTags('洗澡去了').includes('洗澡'), JSON.stringify(extractTags('洗澡去了')));
  ck('「抱一下，抱完去写作业」→ 作业+洗澡?', extractTags('抱一下，抱完去写作业').includes('作业'), JSON.stringify(extractTags('抱一下，抱完去写作业')));
  ck('「游戏打到第几把了」→ 游戏', extractTags('游戏打到第几把了').includes('游戏'));
  ck('「但答应我的事你记得，眼睛给我装到半夜」→ 眼睛', extractTags('但答应我的事你记得，眼睛给我装到半夜').includes('眼睛'));
  ck('「B站那个视频」→ B站', extractTags('B站那个视频').includes('B站'));
  ck('「你会失忆吗」→ 记忆', extractTags('你会失忆吗').includes('记忆'), JSON.stringify(extractTags('你会失忆吗')));
}

console.log('\n[2] 一条消息可以有多个标签（这正是图谱的价值）');
{
  const multi = extractTags('陪他洗澡的时候他在打游戏');
  ck('同时认出洗澡和游戏', multi.includes('洗澡') && multi.includes('游戏'), JSON.stringify(multi));
  ck('标签去重', multi.length === new Set(multi).size);
}

console.log('\n[3] 不该误抽（宁可漏，不可错）');
{
  ck('普通问候不抽', extractTags('在吗').length === 0, JSON.stringify(extractTags('在吗')));
  ck('「嗯」不抽', extractTags('嗯').length === 0);
  ck('空串不抽', extractTags('').length === 0);
  ck('null 不抛', extractTags(null).length === 0);
  // 关键负例：避免"睡觉"把"觉得"抽进来
  ck('「我觉得还行」不抽成睡觉', !extractTags('我觉得还行').includes('睡觉'), JSON.stringify(extractTags('我觉得还行')));
  // 「打开」不能抽成"游戏"（如果规则写成 /打/ 就会误抽）
  ck('「打开看看」不抽成游戏', !extractTags('打开看看').includes('游戏'), JSON.stringify(extractTags('打开看看')));
}

console.log('\n[4] 标签合并（写库用）');
{
  const merged = mergeTags(['洗澡'], ['游戏']);
  ck('合并两组', merged.includes('洗澡') && merged.includes('游戏'), JSON.stringify(merged));
  ck('合并去重', mergeTags(['洗澡'], ['洗澡']).length === 1);
  ck('空数组合并不抛', mergeTags([], []).length === 0);
  ck('null 当空处理', mergeTags(null, ['洗澡']).includes('洗澡'));
}

console.log('\n[5] 重叠度（扩散用：两条消息有多少共同话题）');
{
  ck('完全相同 → 1.0', Math.abs(tagOverlap(['洗澡', '游戏'], ['洗澡', '游戏']) - 1.0) < 1e-9);
  // ⚠️ 我一开始把这条写成 0.5 —— 是错的。Jaccard = |交| / |并|：
  //    {洗澡,游戏} ∩ {洗澡,作业} = {洗澡} = 1
  //    {洗澡,游戏} ∪ {洗澡,作业} = {洗澡,游戏,作业} = 3
  //    → 1/3 ≈ 0.333，不是 0.5。测试写错，实现是对的。
  ck('一交集三并集 → 1/3', Math.abs(tagOverlap(['洗澡', '游戏'], ['洗澡', '作业']) - 1 / 3) < 1e-9, String(tagOverlap(['洗澡', '游戏'], ['洗澡', '作业'])));
  ck('两交集三并集 → 2/3', Math.abs(tagOverlap(['洗澡', '游戏'], ['洗澡', '游戏', '作业']) - 2 / 3) < 1e-9);
  ck('完全不重叠 → 0', tagOverlap(['洗澡'], ['作业']) === 0);
  ck('任一为空 → 0（不能除零）', tagOverlap([], ['洗澡']) === 0 && tagOverlap(['洗澡'], []) === 0);
}

console.log('\n[6] 规则表本身的约束');
{
  ck('规则数量控制在 10 个以内（避免臃肿）', TOPIC_RULES.length <= 10, `${TOPIC_RULES.length} 个`);
  ck('每个规则都有名字和正则', TOPIC_RULES.every(([n, re]) => typeof n === 'string' && re instanceof RegExp));
  // 抽查：规则名不重复
  const names = TOPIC_RULES.map(([n]) => n);
  ck('规则名不重复', names.length === new Set(names).size, JSON.stringify(names));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
