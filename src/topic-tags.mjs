// 话题标签（"图谱"的极简版）：给每条消息打几个话题标签，用于**扩散检索**。
//
// ── 为什么不是真正的知识图谱 ──────────────────────────────────────────
// memory-brain 用 entities + relations 两张表 + LLM 抽实体抽关系（DESIGN.md:66）。
// 我们实测过：917 条消息按 6 类话题抽，实体 6 个、关系只有 4 条、合计 < 1KB。
// 也就是说——**在她的对话上，那两张表几乎是空的**，建了等于没建。
//
// 所以改用最朴素的形式：messages.tags 一个字段，存「洗澡,游戏」这种逗号串。
//   · 不建表 → 零迁移成本
//   · 检索直接 WHERE tags LIKE '%洗澡%' → 走现有索引
//   · 数据量：917 条 × 平均 1.2 个标签 ≈ 10KB
//
// ── 它的真实价值（有实测）─────────────────────────────────────────────
// 不是替代检索，是**把找到的一条扩成一小组**：
//   实测「上次打游戏打到第几把」→ FTS 1 条，按话题扩散 8 条。
//   这就是人说话的方式：提一件事，想起一串。
//
// ── 硬前提 ────────────────────────────────────────────────────────────
// 必须先有种子（FTS 先找到至少一条），才能按话题扩散。
// 种子都没有时救不了 —— 实测「我不吃香菜」这类从没提过的东西，图谱也 0 命中。
//
// ── 规则设计原则 ──────────────────────────────────────────────────────
// ① 宁可漏，不可错：「打开看看」不能被抽成「游戏」（所以不能用单字 /打/）
// ② 话题数控制在 10 个以内 —— 超过就说明粒度太细，反而稀释扩散效果
// ③ 每个话题要有足够多的消息支撑，否则扩散没意义

/**
 * 话题规则：[话题名, 正则]
 *
 * ⚠️ 这些话题是按她**真实对话**里出现频率排的（scripts/analyze-graph-value.mjs 实测）：
 *   吃饭 65 / 睡觉 65 / 表情包 34 / 桥接 22 / B站 19 / 洗澡 13 / 眼睛 10 / 游戏 8 / 作业 8 / 契阔 3
 *
 * 每条正则都刻意避开单字歧义：
 *   · 「睡觉」不能匹配「觉得」→ 用 /睡/ + 限定词
 *   · 「游戏」不能匹配「打开」→ 必须出现「游戏」或「打游戏」
 */
export const TOPIC_RULES = [
  // 交流媒介类
  ['表情包', /表情包|表情|贴纸/],
  ['B站', /B站|b站|视频|弹幕|up主/],
  // 生活日常
  ['洗澡', /洗澡|冲洗|泡着|浴缸|吹头/],
  ['吃饭', /吃饭|吃了|好吃|外卖|饿|做饭/],
  ['睡觉', /睡觉|睡了|睡着|熬夜|躺下|几点睡|困了/],
  // 你们之间的事
  ['游戏', /游戏|打游戏|方舟|塔露拉|明日方舟/],
  ['作业', /作业/],
  ['眼睛', /眼睛|装眼睛|看清/],
  // 系统相关（她确实会聊这些）
  // ⚠️ 「失忆」必须在这里：实测她反复说「你会失忆吗」「换了就是失忆」，
  //    这是她对话里最重的话题之一（test-topic-tags.mjs 锁住）。
  ['记忆', /桥接|token|上下文|记忆|失忆/],
  ['契阔', /契阔|写信|要记牢/],
];

/**
 * 从一句话里抽出话题标签。抽不到返回空数组（不是 null，调用方不用判空值）。
 *
 * @param {string} text
 * @returns {string[]} 去重后的话题名
 */
export function extractTags(text) {
  const t = String(text ?? '');
  if (!t) return [];
  const out = [];
  for (const [name, re] of TOPIC_RULES) {
    if (re.test(t) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 合并两组标签（用于「原有标签 + 新算出来的」）。
 * 去重、保序。
 */
export function mergeTags(a, b) {
  const out = [];
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const name = String(x ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 两条消息的话题重叠度（0~1），用于排序扩散结果。
 *
 * 用 Jaccard：交集中除以并集。为什么不用"交集数"：
 *   交集数在有 5 个标签的消息上天然更大，会让"标签多的"永远排前面，
 *   而不是"和种子真正相关的"。
 */
export function tagOverlap(a, b) {
  const A = new Set(Array.isArray(a) ? a.filter(Boolean) : []);
  const B = new Set(Array.isArray(b) ? b.filter(Boolean) : []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 把标签数组序列化成入库格式（逗号分隔）。空数组 → 空串。 */
export function serializeTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter(Boolean).join(',');
}

/** 解析入库格式。空串 / null → 空数组。 */
export function parseTags(str) {
  return String(str ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
