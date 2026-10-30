// 冷存储检索（SQLite 版）：按关键词在当前会话的存档里找回旧对话片段。
//
// 用途：桥接在唤醒时调用，把 1-2 条"以前聊过、和现在这句相关"的片段附到提示词里。
// 不给她工具（她不查），也不改安全边界（不动 MCP / 白名单）。
//
// 检索策略见 src/archive-store.mjs 顶部：≥3 字走 FTS5 trigram，≤2 字走 LIKE。
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArchiveStore } from './archive-store.mjs'
import { parseWhen, dayOf } from './when-cn.mjs'

/**
 * 把一句中文切成检索词：短句整体、长句**滑动**切 2 字块、英文按词。
 *
 * ⚠️ 2026-10-30 修的 bug（test-tokenize.mjs 锁住）：
 *   原来长句用 `i += 2` **跳步**切，于是「你陪我洗澡那次」被切成
 *   ["你陪","我洗","澡那"] —— "洗澡"这个真实存在的词根本没进检索词，
 *   所以永远查不到（实测「洗澡」在库里出现 9 次，这条查询却 0 命中）。
 *
 *   改成 `i += 1` 滑动切，保住所有相邻二字组合。
 *   代价是词数大约翻倍，所以下面仍然截到 12 个（上限不变）。
 *
 * 短句（≤4 字）保持整体：中文里「洗澡」「作业」这种双字词是语义单位，
 * 拆开反而丢信息。5 字以上才进滑动切分。
 */
export function queryTokens(text) {
  const out = new Set()
  for (const run of String(text ?? '').match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 4) out.add(run)
    else for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  for (const word of String(text ?? '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) out.add(word)
  return [...out].slice(0, 12)
}

function stamp(ms) {
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 从查询里剥离时间说法，只留内容词。
 *
 * 为什么需要（2026-10-30 实测）：不剥的话「作业 前天」会变成 ["作业","前天"]，
 * minHits 抬到 2，要求一条消息里同时含「作业」和「前天」—— 永不命中。
 * 时间是**过滤维度**，不是检索内容。
 *
 * ⚠️ 只剥时间词本身，不动其他字。宁可漏剥（退回原行为）也不能误伤内容：
 *    「前天」剥掉没问题，但如果把「前」单字也剥了，会把「前面」「以前」弄坏。
 */
export function stripWhenWords(text) {
  let s = String(text ?? '')
  // 绝对日期
  s = s.replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
  // X月Y号/日（含中文数字）
  s = s.replace(/(?:\d{1,2}|[一二三四五六七八九十]+)月(?:\d{1,2}|[一二三四五六七八九十]+)[日号]/g, ' ')
  // 上/本月（含分档词）
  s = s.replace(/(?:上个?月|这个?月|本月)(?:初|上旬|中旬|下旬|底|末)?/g, ' ')
  // 大前天 / 前天 / 昨天 / 昨晚（长词先剥，避免「前天」被「昨天」替换后残留）
  s = s.replace(/大前天|前天|昨天|昨晚/g, ' ')
  // N天前
  s = s.replace(/(?:\d+|[一二三四五六七八九十两]+)天前/g, ' ')
  // 上/上上周（可带星期几）
  s = s.replace(/(?:上上|上)(?:个)?(?:周|星期|礼拜)(?:[一二三四五六日天])?/g, ' ')
  // 「今天/现在/刚才」这类不影响检索的虚词也一并去掉，减少噪音
  s = s.replace(/今天|今晚|现在|刚才|刚刚/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * @param {object} options
 * @param {string} options.dbPath        state/archive.db
 * @param {string} options.key           会话 key（private:xxx）
 * @param {string} options.query         当前在聊的内容
 * @param {number} [options.before]      只看这个时间戳之前（默认排除最近 10 分钟）
 * @param {number} [options.limit]
 * @param {number} [options.minHits]
 * @param {number} [options.maxChars]
 */
export function recallSnippets({
  dbPath,
  key,
  query,
  before = Date.now() - 10 * 60 * 1000,
  limit = 2,
  minHits = 2,
  maxChars = 60,
} = {}) {
  const now = Date.now()
  // L1（2026-10-30）：先解析时间说法，并把时间词从查询里**剥掉**再分词。
  // ⚠️ 这一步是实测抓出来的：不剥的话「作业 前天」会被切成 ["作业","前天"]，
  //    minHits 抬到 2 → 要求消息里同时出现「作业」和「前天」，几乎永不命中
  //    （实测 10-27 有 8 条「作业」，却因门槛变成 0 条）。
  //    时间词是**过滤条件**，不是内容词，不该参与命中计数。
  const dayRange = parseWhen(query, dayOf(now))
  const contentQuery = dayRange ? stripWhenWords(query) : query
  const tokens = queryTokens(contentQuery)
  if (!tokens.length) return []
  // 门槛：**词数推导出来的值是下限，minHits 只能往上抬，不能往下压。**
  //
  // ⚠️ 2026-10-30 这里改了两版，事后核对发现：**两版在生产里都没有实际作用**，留档说明。
  //
  //   原始实现：这里压根不看入参 `minHits`，自己算 `need = min(词数, 词数>=4?3:2)`。
  //
  //   第一版（错）：「入参 minHits 优先」。看起来"修好了参数"，实际把**默认门槛从 3 降到 2**——
  //     因为 bridge.js 永远传 `Math.max(2, cfg.minHits || 2)` = 2，而原实现长句用 3。
  //     实测这一降让「抱着打游戏」「我不吃香菜」多捞回无关对话（「是我打游戏没理你生气了吗」），
  //     命中 14/20 → 16/20 但**质量下降**。这是"改了行为却说自己在修 bug"。
  //
  //   第二版（现在这版）：「词数推导值当**下限**」。它确实修好了"参数是死的"这个表述问题，
  //     但 **bridge 的调用形态下是 no-op**：它传的 minHits 恒为 2，
  //     而 autoNeed 在 1/2/3 词时是 1/2/2、≥4 词时是 3 —— 取 max 之后结果与原来逐一相同。
  //     实测：20 个查询 × 3 个 limit 的 bridge 调用形态，新旧结果**0 差异**。
  //     只有"有人传 minHits ≥ 4"时行为才会不同，而那时**收益是负的**（实测会引入噪声，见 C 那段）。
  //
  //   结论：这一版留着（语义更诚实、参数不再骗人），但**不要把它当成"性能或质量改进"**。
  //   同理下面的 `want` 归一化也是 no-op：bridge 传的 limit 恒在 1..3 的整数，
  //   永远碰不到 NaN/0/负数那条路径。它只是给"外部脚本乱传参"上了一道保险。
  const autoNeed = Math.min(tokens.length, tokens.length >= 4 ? 3 : 2)
  // 归一化 limit：NaN / 0 / 负数 / 小数会让候选池和 `.slice()` 变成空结果且**不报错**。
  // ⚠️ 对当前生产调用是 no-op（bridge 恒传 1..3 整数），只为外部脚本兜底。
  const want = Math.max(1, Math.min(10, Math.round(Number(limit) || 2)))
  const askNeed = Number(minHits)
  const need = Number.isFinite(askNeed) && askNeed > 0
    ? Math.min(tokens.length, Math.max(autoNeed, Math.round(askNeed)))
    : autoNeed
  // 长句被截到 12 个词（queryTokens 上限），候选池按"词数"放大才够用。
  const store = new ArchiveStore(dbPath)
  try {
    const rows = store.search({ key, tokens, before, limit: want * 3, minHits: need })
    // L1：话里有「上周三」「8月3号」「三天前」这类时间说法时，只在那个日期区间里找。
    // 原来完全没有这一步 —— 「上周三说的那句」只能靠关键词全库搜 + 时间衰减碰运气。
    // 注意：找不到时间说法（parseWhen 返回 null）时**保持原行为**，不改变现状。
    const inRange = dayRange
      ? rows.filter((row) => { const d = dayOf(Number(row.t)); return dayRange[0] <= d && d <= dayRange[1] })
      : rows
    if (dayRange && !inRange.length) {
      // 时间窗里确实没有 → 明确返回空，不再回退到全库（否则等于时间过滤没生效）
      return []
    }
    // ── 三因子打分（2026-10-30）──────────────────────────────────────────
    // 取代原来的 `hits * (30天内 ? 1.3 : 1)` 硬跳变。
    //
    // 为什么要改（实测依据 token-usage.jsonl）：
    //   她的对话每天 173 条，一年约 6.3 万条。原规则下「超过30天」的全部权重 1.00，
    //   一个 365 天前的旧事得分是今天消息的 77% —— 它们同权竞争仅有的 2 个位置。
    //
    // 三因子的权重分配参考 memory-brain 的 DESIGN.md:76-80（它用 5 路，我们去掉了
    // 向量和图谱那两路，把权重并回 BM25 与 recency）：
    //   FTS 命中率 0.55 / importance 0.25 / recency 0.20
    //
    // recency 半衰期取 14 天（memory-brain DESIGN.md:79 的原值），不是我之前说的 45 天。
    // 为什么不用它那种"四档阶跃"：实测差异在 14–90 天完全平权，等于没衰减。
    const RECENCY_HALF_LIFE_DAYS = 14;
    const recency = (t) => {
      const ageDays = Math.max(0, (now - Number(t)) / 86400000);
      return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
    };
    const tokenCount = Math.max(1, tokens.length);
    // ⚠️ 2026-10-30：这里我连续改错三版，最后**全部回退**。记下来，因为它是最好的反面教材。
    //
    //   起因：交接单（我自己写的）把「limit=1 实际返回 3 条」记成了 bug B。
    //   **那个判断本身就是错的。** 原设计是明确的：
    //     · `limit` 限制的是**关键词命中条数**（`ranked.slice(0, limit)`）
    //     · 扩散（`expand`）是在命中之外的**额外补充**（合并时不做总量截断）
    //   证据就在本段下面那句注释里：「扩散是"补充"，不该喧宾夺主」——
    //   既然是"补充"，它当然不占 limit 的名额。**返回 3 条不是违约，是设计。**
    //
    //   第一版：ranked 先截 + 合并后再截 → 双重截断，扩散**整段消失**（实测 21 次 0 次出现）。
    //   第二版：ranked 不截 + 按 limit 分配名额 → 扩散回来了但**压过命中**（want=3 时 1 命中 + 2 扩散）。
    //   第三版：加"扩散不超过命中数"约束 → 4 个查询全部变成 0 扩散，功能等于又关了。
    //
    //   三版都在"修一个不存在的 bug"，而且每一版都真的弄坏了东西。
    //   现在：**恢复原样**，只保留一个与本 bug 无关的真修复（limit 的 NaN/0 归一化，见上面）。
    const ranked = inRange
      .map((row) => {
        const hitsRate = Math.min(1, (Number(row.hits) || 0) / tokenCount);
        // importance 可能是 null（老数据）/0（异常），一律按默认 0.5 兜底
        const imp = Number.isFinite(Number(row.importance)) ? Number(row.importance) : 0.5;
        const rec = recency(row.t);
        return { ...row, score: 0.55 * hitsRate + 0.25 * imp + 0.20 * rec };
      })
      .sort((a, b) => b.score - a.score || b.t - a.t)
      .slice(0, want)
    //   （第一版在这里 slice(0, want)，扩散种子被砍到 want 条 → 扩散整段死掉。）
    // ── 话题扩散（2026-10-30，"图谱"的极简版）────────────────────────────
    // 把 FTS 命中的那几条当种子，按共同话题再带回 1-2 条。
    // 实测价值：「上次打游戏打到第几把」FTS 1 条 → 扩散后 8 条可选。
    //
    // ⚠️ 只带 1-2 条，不是越多越好：扩散是"补充"，不该喧宾夺主。
    //   而且只有 FTS 有命中时才会扩散（没种子就不扩散）。
    let expanded = []
    try {
      if (typeof store.expand === 'function' && ranked.length) {
        expanded = store.expand({
          key,
          seedIds: ranked.map((r) => Number(r.id)).filter(Number.isFinite),
          limit: 2,
          before,
        })
      }
    } catch { expanded = [] }
    // 合并：命中在前，扩散在后（不按分数混排 —— 扩散的分数量纲不同，
    // 混排会让"只有话题重叠、完全没命中关键词"的旧事挤掉真正命中的）
    //
    // ⚠️ 这里**不做总量截断**，这是原设计，不是遗漏：
    //   `limit` 管的是**命中条数**，扩散是命中之外的补充，总数可以是 limit + 扩散条数。
    //   「扩散是补充，不该喧宾夺主」靠两件事保证：① 顺序（命中永远排前面）；
    //   ② expand 自己 limit=2，最多只带 2 条。
    //   加总量截断反而会把扩散挤掉 —— 我改了三版，每版都验证过这一点。
    const merged = [...ranked, ...expanded];
    // ⚠️ 2026-10-30 深度自检补漏：这里必须回写 access_count / last_access。
    //   没有这一句的话，衰减脚本里"近 30 天访问过就减半衰减"的分支永远不成立
    //   （access_count 恒为 0）—— 整个"频率感知衰减"等于没实现。
    //   只对**最终返回的这几条**回写（不是候选集），否则噪声也会被当成重要。
    const mergedIds = merged.map((r) => Number(r.id)).filter(Number.isFinite)
    if (typeof store.touchAccess === 'function') {
      try { store.touchAccess(mergedIds, now) } catch { /* 排序权重，失败无妨 */ }
    }
    const seedIds = new Set(ranked.map((r) => Number(r.id)))
    return merged.map((row) => {
      const sender = String(row.sender ?? '').trim()
      const who = row.side === 'her'
        ? '你'
        : (sender && !/^(私聊|群聊|好友)$/.test(sender) ? sender : '他')
      return {
        t: Number(row.t),
        label: stamp(row.t),
        who,
        text: String(row.text).replace(/\s+/g, ' ').slice(0, maxChars),
        // 扩散来的要标出来：调用方/日志能分清"关键词命中"和"同话题带回来的"
        fromTopic: !seedIds.has(Number(row.id)),
        // ⚠️ 2026-10-30 自检抓到：这里原来写的是 `Number(row.hits)`，
        //    把上面三因子算出来的 score **覆盖掉了** —— 排序用的是三因子，
        //    但返回给调用方的仍是"命中词数"，日志/调试时会看到全是 1。
        //    现在保留三因子分，另给 hitCount 便于排查。
        score: Number(row.score) || 0,
        hitCount: Number(row.hits) || 0,
      }
    })
  } finally {
    store.close()
  }
}

// 直接运行：node src/recall.mjs "关键词" [key]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const query = process.argv[2] ?? ''
  const key = process.argv[3] ?? 'private:<OWNER_QQ>'
  const dbPath = path.resolve(import.meta.dirname, '..', 'state', 'archive.db')
  const hits = recallSnippets({ dbPath, key, query, before: Date.now(), limit: 5, minHits: 2 })
  if (!hits.length) console.log('（没有命中）')
  for (const h of hits) console.log(`${h.label} ${h.who}：[${h.score}] ${h.text}`)
}
