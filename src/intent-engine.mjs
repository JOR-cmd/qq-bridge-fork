/**
 * 目的引擎（本地化精简版，参照 Mieksido/surfcore 的 src/purpose-engine.js 思路）。
 *
 * 解决的问题（2026-10-28）：
 *   我们的「主动机会」原来只有一个 `proactiveProbability: 0.2` —— 每次判定 20% 概率
 *   把她叫醒，问她「要不要主动说句话」。可她被叫醒时**没有任何"想说什么"的输入**，
 *   只能靠搜热点 + 通用模板硬凑。这就是「呆」的内容层成因：
 *   说法像是"该发消息了"，不是"我突然想起来一件事"。
 *
 * surfcore 的做法是：先算「目的」，再决定说不说。抽过来的核心是三条：
 *   1. **需求向量**：9 个维度，随时间衰减、被"他多久没理我"推高、被最近看到的素材推高。
 *      于是"她今天为什么特别想说话"是可解释的，不是掷骰子。
 *   2. **人格卡 → 动机先验**：人格里写着"黏人/心软/傲娇"的人，同样的素材下更容易被
 *      「陪」「关心」打动。人格卡不只是语气模板，它影响她想做什么。
 *   3. **目标的归属**：区分「我的 / 他的 / 群友的 / 视频里的」。
 *      这条治的是"为了接梗而接梗" —— 她把别人的事当成了自己的事。
 *
 * 模块边界：**零 I/O、零 import、零状态**。纯函数，单测只测这里。
 * 副作用（读盘、发消息、写状态）全部留在 bridge.js。
 */

// ── 需求维度 ────────────────────────────────────────────────────────────────
//
// 私聊陪聊场景，9 维里挑了 5 个真正用得上的（surfcore 那 9 维面向群聊 + B站，
// 其中 learn/install/create/consume 在我们这里没有素材支撑，留着只会产生噪声）。
export const NEEDS = Object.freeze(['connect', 'care', 'share', 'curiosity', 'play']);

export const NEED_LABELS = Object.freeze({
  connect: '陪', care: '关心', share: '分享', curiosity: '好奇', play: '玩',
});

/** 基线需求。所有值都在 0~1，1 = 满得要溢出来。 */
export const DEFAULT_DRIVES = Object.freeze({
  connect: 0.30, care: 0.22, share: 0.18, curiosity: 0.15, play: 0.10,
});

/**
 * 人格卡 → 动机先验。**这是 surfcore 最值得抄的一条**。
 *
 * 不是给模型看的标签，而是让同一套机制在载入不同人格卡时，天然偏向不同的需要：
 * 黏人的人更容易想"陪"，心软的人更容易想"关心"，话多的人更容易想"分享"。
 *
 * 用「地板」而不是「累加」：否则每轮都 +bias，几十轮后所有维度都会被顶到 1。
 */
const PERSONA_WORDS = Object.freeze({
  connect: ['黏人', '粘人', '怕孤独', '寂寞', '陪', '依赖', '亲近', '撒娇', '亲', '喜欢他'],
  care: ['温柔', '关心', '体贴', '照顾', '心软', '共情', '在意', '担心'],
  share: ['话多', '话痨', '分享', '表达', '吐槽', '嘴碎', '爱说'],
  curiosity: ['好奇', '好学', '研究', '为什么', '琢磨', '聪明'],
  play: ['爱玩', '贪玩', '玩梗', '娱乐', '梗', '好玩', '轻松', '摆烂'],
});

/** 一段文本指向哪些需要（0~1/维）。 */
const NEED_WORDS = Object.freeze({
  connect: ['想你', '陪你', '陪我', '晚安', '早安', '在吗', '抱', '亲', '喜欢', '想见'],
  care: ['累', '困', '作业', '加班', '考试', '面试', '生病', '难受', '压力', '睡', '吃饭', '休息', '疼'],
  share: ['好笑', '离谱', '可爱', '梗', '笑死', '给你看', '有趣', '绝了', '看这个', '分享'],
  curiosity: ['为什么', '怎么', '什么', '哪', '是不是', '原理', '查', '搜', '视频', '文章'],
  play: ['游戏', '玩', '开黑', '抽卡', '看番', '摆烂', '摸鱼'],
});

export function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export function normalizeDrives(input) {
  const out = { ...DEFAULT_DRIVES };
  if (!input || typeof input !== 'object') return out;
  for (const need of NEEDS) {
    const n = Number(input[need]);
    if (Number.isFinite(n)) out[need] = clamp01(n);
  }
  return out;
}

/** 文本 → 需求向量。没有任何命中时给 share 一点底（人总会想说点什么）。 */
export function needAffinity(rawText) {
  const t = String(rawText ?? '').toLowerCase();
  const out = {};
  let any = 0;
  for (const need of NEEDS) {
    let hits = 0;
    for (const word of NEED_WORDS[need]) if (t.includes(word)) hits += 1;
    const value = Math.min(1, hits / 2.5);
    out[need] = value;
    if (value > 0) any += 1;
  }
  if (!any) out.share = 0.3;
  // 交叉增强：提到"累"又提到"我陪你"时，既是关心也是陪。
  if (out.care > 0 && out.connect > 0) out.connect = Math.min(1, out.connect + 0.15);
  return out;
}

/** 人格卡 → { bias, traits }。bias 用作驱动地板，traits 可用于日志/调试。 */
export function analyzePersonaBias(rawText) {
  const t = String(rawText ?? '').toLowerCase();
  const bias = {};
  const traits = [];
  for (const need of NEEDS) {
    let hits = 0;
    for (const word of PERSONA_WORDS[need]) if (t.includes(word)) hits += 1;
    const value = Math.min(0.22, hits * 0.055); // 上限刻意低：先验只做偏置，不该盖过真实素材
    bias[need] = value;
    if (hits > 0) traits.push({ need, label: NEED_LABELS[need], hits, bias: value });
  }
  traits.sort((a, b) => b.hits - a.hits || b.bias - a.bias);
  return { bias, traits, hasText: Boolean(String(rawText ?? '').trim()) };
}

const HOUR = 60 * 60 * 1000;

/**
 * 驱动状态推演：**这是"她今天为什么特别想说话"的可解释来源**。
 *
 *   ① 所有维度向基线衰减（半衰期 8 小时）；
 *   ② 他多久没说话 → connect 往上涨（寂寞不是随机出现的）；
 *   ③ 最近看到的素材 → 对应维度被推高；
 *   ④ 人格卡先验 → 抬高地板。
 *
 * ⚠ **这个函数必须是幂等的**：同样的入参算几次都得同一个结果。
 * 它算的是「在 drivesAt 那一刻存下的状态，到 now 时**应该是**多少」——
 * 不是在现有值上再推一次。调用方不要在读完后又把它写回当基线，
 * 否则每次调用都再推高一遍（实测 share 0.649 → 0.773 → 0.897，越算越满）。
 *
 * 推进状态请用 `commitDrives()`。
 */
export function deriveDrives({
  drives, drivesAt = 0, materials = [], now = Date.now(),
  lastMasterAt = 0, personaBias = null, random = Math.random,
} = {}) {
  const next = normalizeDrives(drives);
  const hours = drivesAt > 0 ? Math.min(72, Math.max(0, (now - Number(drivesAt)) / HOUR)) : 0;
  const decay = Math.pow(0.5, hours / 8);
  for (const need of NEEDS) {
    next[need] = DEFAULT_DRIVES[need] + (next[need] - DEFAULT_DRIVES[need]) * decay;
  }
  if (personaBias && typeof personaBias === 'object') {
    for (const need of NEEDS) {
      const bias = Number(personaBias[need]);
      if (Number.isFinite(bias) && bias > 0) {
        next[need] = Math.min(1, Math.max(next[need], DEFAULT_DRIVES[need] + Math.min(0.3, bias)));
      }
    }
  }
  // 多久没和他说话 → 想陪的需求涨。
  //
  // ⚠ 2026-10-29 连改三次才对，记下来免得再犯：
  //   ① `next.connect += 增量` —— 每推进一次再加一遍，推两次就冲到封顶 0.953。
  //   ② 改成「扣掉上一轮已计入的部分再补」 —— 矫枉过正：`drivesAt` 越新扣得越多，
  //      于是**他明明 24 小时没说话，connect 只有 0.29**；而且 1h 和 48h 算出来几乎一样。
  //
  // 根因：drivesAt 和 lastMasterAt 的先后关系是不确定的
  //      （实测：21:25 存值，他 01:04 才说话 —— drivesAt 早于 lastMasterAt），
  //      拿 drivesAt 反推"当时有多寂寞"根本不成立。
  //
  // 正解：**寂寞不写进 drives**。它就是「现在离他最后说话多久」的纯函数，
  //      由 topNeeds / buildIntentBlock 在**读取时**叠加。
  //      drives 里只留时间衰减后的稳定状态 —— 天然幂等，也不会累积。
  //      （这里什么都不加，见 withLoneliness()。）
  // 最近看到的素材推高对应需求。
  // ⚠ 只算**窗口内**的素材，且按"距 now 多远"衰减加权 —— 这样同一批素材
  // 反复计算结果一致（幂等），同时"刚看到的"影响大、"几小时前的"影响小。
  for (const m of (Array.isArray(materials) ? materials : []).slice(0, 12)) {
    const at = Number(m?.time) || 0;
    const ageH = at > 0 ? Math.max(0, (now - at) / HOUR) : 0;
    if (at > 0 && ageH > 24) continue; // 一天前的素材不该还在推高
    const recency = at > 0 ? Math.max(0, 1 - ageH / 24) : 1;
    const aff = m?.needAffinity ?? needAffinity(`${m?.title ?? ''} ${m?.text ?? ''}`);
    for (const need of NEEDS) {
      next[need] = Math.min(1, next[need] + (Number(aff?.[need]) || 0) * 0.04 * recency);
    }
  }
  // ⚠ 抖动**不写进状态**（2026-10-29 自检抓出来的真 bug）。
  //
  // 原来这里是 `next[need] += (seed - 0.5) * 0.02` —— 看似无害，但 next 会被
  // commitDrives 存回 st.drives，于是**每一轮推进都在上一轮已含抖动的基础上再加一次**。
  // 实测固定时钟连跑 100 轮：connect 0.50 → 0.86 → **1.0000（封顶）**，
  // 连没人格地板、没有素材的 care 也从 0.2226 一路涨到 0.2328。
  //
  // 正确做法：抖动只属于「展示层」—— 想让人格有"今天和昨天不太一样"的手感，
  // 就在读取时（withJitter）叠，绝不写回状态。状态必须只由衰减 + 素材决定。
  return { drives: next, drivesAt: now };
}

/**
 * 读取时的确定性抖动：给「今天和昨天不太一样」一点手感。
 * 不写回状态 —— 写回就会像上面那样一轮轮累积到封顶。
 */
export function withJitter(drives, { now = Date.now() } = {}) {
  const out = normalizeDrives(drives);
  const seedBase = String(Math.round(Number(now) / 60000)); // 同一分钟内稳定
  for (const need of NEEDS) {
    out[need] = clamp01(out[need] + (hash01(`${seedBase}|${need}`) - 0.5) * 0.02);
  }
  return out;
}

/** 稳定哈希 → 0~1（FNV-1a 变体，够用且无依赖）。 */
function hash01(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * 推进驱动状态：**只有这一条路径可以写入 st.drives / st.drivesAt**。
 *
 * 为什么要分开：原来 derive + 立刻写回是同一个动作，导致
 *   ① 同一次唤醒里调两次 → 推高两次（实测 0.649→0.773→0.897）；
 *   ② 每次都把 drivesAt 重置成 now → 衰减周期被无限推迟，永远衰不掉。
 * 现在规定：**读只用 deriveDrives（不写回）；推进只在回合结束时调一次**。
 */
export function commitDrives(prev, { now = Date.now(), minIntervalMs = 60_000 } = {}) {
  if (!prev || typeof prev !== 'object') return { drives: normalizeDrives(null), drivesAt: 0, committed: false };
  // 一分钟内重复推进没有意义（而且会把衰减周期搅乱）
  const lastAt = Number(prev.drivesAt) || 0;
  if (lastAt > 0 && now - lastAt < minIntervalMs) {
    return { drives: normalizeDrives(prev.drives), drivesAt: lastAt, committed: false };
  }
  return { drives: normalizeDrives(prev.nextDrives ?? prev.drives), drivesAt: now, committed: true };
}

/**
 * 在**读取时**把「他多久没说话」的寂寞叠加到 connect 上。
 *
 * 为什么放在读取而不是写回（2026-10-29 三次改错换来的结论）：
 *   · 写回会累积（推两次就封顶），或者矫枉过正（drivesAt 越新、寂寞被扣得越多）；
 *   · 而且 drivesAt 和 lastMasterAt 的先后关系不确定，拿 drivesAt 反推不成立。
 *
 * 寂寞本身是「现在离他最后说话多久」的纯函数 —— 只要不写进状态，
 * 就永远幂等、永远不会累积。
 *
 * @param {object} drives     deriveDrives 算出来的基础向量（不含寂寞）
 * @param {number} lastMasterAt 他最后说话的时间
 * @param {number} now
 * @returns 叠加寂寞后的新对象（不改入参）
 */
export function withLoneliness(drives, lastMasterAt = 0, now = Date.now()) {
  const base = normalizeDrives(drives);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - Number(lastMasterAt)) / HOUR) : 24;
  const lonely = Math.min(0.4, (hoursSinceMaster / 24) * 0.4);
  return { ...base, connect: clamp01(base.connect + lonely) };
}

/** 取当前最强的 1~2 个需求，用于提示词。低于阈值的算"没什么特别想要的"。 */
export function topNeeds(drives, { min = 0.28, limit = 2 } = {}) {
  return NEEDS
    .map((need) => ({ need, label: NEED_LABELS[need], score: clamp01(drives?.[need]) }))
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score >= min)
    .slice(0, limit);
}

// ── 未闭合的事（open loops）──────────────────────────────────────────────────
//
// 这是"惦记"的来源。真人主动找人，多半不是"到点了"，而是"那件事还没完"。
//
// 《目标的归属》—— surfcore 用它治"为了接梗而接梗"：
//   owner  = 他说的、关于他的事       → 可以关心、可以问
//   self   = 她说过要做的、还没做的   → 可以自己接上
//   member = 群友的事                → 只能聊，不能说成"我也"
//   media  = 视频/文章里的说法        → 可以分享、求证，别当成自己的决定
export const GOAL_OWNER_LABELS = Object.freeze({
  self: '我', owner: '他', member: '群友', media: '视频里',
});

const QUESTION_TAIL_RE = /[?？]\s*$/;
// 疑问词在结尾。⚠ 末尾的「没/没有」很常见（"装好了没""吃了吗"），必须单列：
// 只在词表里写「有没有」会漏掉「装好了没」这种（实测漏判，测试第 7 节抓出来的）。
const QUESTION_WORD_RE = /(吗|嘛|么|咋|怎么|为什么|为啥|什么|哪个|哪里|哪儿|谁|多少|几点|是不是|有没有|能不能|可不可以|要不要|好不好|对不对|行不行|在不在|忙不忙|睡了吗|吃了吗|好了没|好没好|完了没|弄好了没|修好了没|看完了没|没|没有)\s*[。！!…～~]*$/;
const REQUEST_RE = /(帮我|帮忙|麻烦你|请你|教我|告诉我|说说|讲讲|发我|给我|推荐|查一下|搜一下|找一下|看一下|写一个|弄一个|来个|整一个)/;

// 她说过"要去做/去看"的承诺语气。⚠ 必须区分「承诺」和「陈述里恰好带时间词」：
// 「难怪，我这边也断了一会儿」只是在说刚才发生了什么，不是承诺（实测误判，真数据跑出来的）。
// 所以要"动作 + 承诺语气"同时成立：回头/稍后/等我/待会 + 一个明确的动作。
const PROMISE_DO_RE = /(回头|稍后|待会|等下|等会儿|一会|马上|晚点|等.{0,4}(再说|看完|写完|弄完|试|查))/;
const PROMISE_ACTION_RE = /(看|查|试|弄|写|做|改|装|找|问|发|给|修|学|研究|弄明白)/;
// 这些是"刚才发生了什么"的叙述，不是承诺
const RETRO_RE = /(刚才|刚才说|难怪|断了|没了|好了|已经|本来|那会儿|上次)/;

// 未来事件：他说"明天/等会/回头"要做什么 —— 这是最自然的"惦记"锚点。
const FUTURE_TIME_RE = /(明天|后天|明晚|今晚|等下|等会|待会|一会儿|回头|晚点|下周|周末|这几天|过两天|马上|快考试|要考试)/;
// 可跟进的具体事：他提到自己在做的事。
// ⚠ 词表要覆盖真实说法：「明天补」「明天交了」这种作业/交作业语境，
// 原来缺「补/交」直接漏判（真数据跑出来的，13 小时前那三句全漏）。
const DOING_RE = /(作业|考试|面试|加班|上班|写|做|装|弄|改|准备|复习|开会|出差|去医院|看病|睡|吃|洗|打游戏|看番|追|下载|练|补|交|画|修|考|背|整理|发)/;

/** 一句话的核心内容，够短才能放进提示词。 */
export function summarize(text, max = 42) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/\[(图片|表情|视频|语音|文件|拍一拍|转发消息)[^\]]*\]/g, '')
    .trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

function isNoise(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 纯表情包 / 纯标点 / 纯复读（草、6、笑死…）
  if (/^\[(图片|表情|视频|语音|文件|拍一拍)[^\]]*\]$/.test(t)) return true;
  if (/^[\s。，、！？!?…~～.]+$/.test(t)) return true;
  if ([...t].length <= 3 && /^(草|6|666|笑死|乐|典|难绷|绝了|？？+|啊|嗯|哦|好|行|收到|哈哈+|hhh+)$/i.test(t)) return true;
  return false;
}

/**
 * 从最近消息里找"还没闭合的事"。
 *
 * @param {object} input
 * @param {Array} input.messages   recentMessages（升序，isSelf 区分双方）
 * @param {number} input.now
 * @param {number} [input.maxAgeMs] 只看这个时间窗内的事（默认 72 小时）
 * @param {number} [input.max]      最多返回几件
 * @returns {Array<{owner,kind,text,why,ageMs,weight,evidence}>}
 */
export function collectOpenLoops({
  messages = [], now = Date.now(), maxAgeMs = 72 * HOUR, max = 4,
  // 「已经惦记过几次」：key -> {count, lastAt}。
  // ⚠ 这是照 surfcore 的 mergeGoal 抄的关键教训：同一批旧素材每轮都在窗口里，
  // 不能让它们每轮都等权地产出。否则「他 13 小时前说明天交了」会在之后每轮
  // 一觉醒都被重新提一次，变成"永久惦记"。用过几次就降权、最后不再进来。
  seenLoops = {},
} = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number(m.time) > 0)
    .slice(-200);
  if (!list.length) return [];

  const loops = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const t = String(m.text ?? m.plain ?? '');
    if (isNoise(t)) continue;
    const age = now - Number(m.time);
    if (age > maxAgeMs) continue;

    // ① 他问过的事，后面没有"她"的回话 → 未答的提问（最硬的 loop）
    if (!m.isSelf) {
      if (QUESTION_TAIL_RE.test(t) || QUESTION_WORD_RE.test(t)) {
        // ⚠ 只有「认真回过」才算答过了。只发一句「嗯/好/草」不构成回答 ——
        // 否则她敷衍一声，这个"惦记"就永远消失了（测试第 7 节抓出来的）。
        const answered = list.slice(i + 1).some((x) => {
          if (!x.isSelf || Number(x.time) <= Number(m.time)) return false;
          const reply = String(x.text ?? x.plain ?? '').trim();
          return reply.length > 0 && !PURE_ACK_RE.test(reply) && !isNoise(reply);
        });
        if (!answered) {
          const key = `q:${summarize(t, 20)}`;
          if (!seen.has(key)) {
            seen.add(key);
            loops.push({
              owner: 'owner', kind: 'unanswered', text: summarize(t),
              why: '他问过，你还没回', ageMs: age,
              weight: 1.0 + Math.min(0.5, age / (24 * HOUR) * 0.5),
              evidence: t.slice(0, 80),
            });
          }
        }
      }
      // ② 他说了未来的事 / 在做的事 → 可以跟进（问一句"做完了没"）
      if (FUTURE_TIME_RE.test(t) && DOING_RE.test(t)) {
        const key = `f:${summarize(t, 18)}`;
        if (!seen.has(key)) {
          seen.add(key);
          loops.push({
            owner: 'owner', kind: 'followup', text: summarize(t),
            why: '他提过要做的事，隔了会儿可以问问', ageMs: age,
            // 6~36 小时之后再问才自然；太近像查岗，太远像忘了
            weight: 0.75 + Math.max(0, 1 - Math.abs(age - 18 * HOUR) / (18 * HOUR)) * 0.5,
            evidence: t.slice(0, 80),
          });
        }
      }
    }
  }

  // ③ 她说过"要/等一下/回头"但没做 → 自己欠着的事（owner=self）
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (!m.isSelf) continue;
    const t = String(m.text ?? m.plain ?? '');
    if (isNoise(t)) continue;
    const age = now - Number(m.time);
    if (age < 20 * 60 * 1000 || age > maxAgeMs) continue; // 20 分钟内不算"忘了"
    // 必须是「承诺去做某事」：既要有承诺语气，也要有明确动作，还要不是回头看叙述。
    // 只匹配时间词会把「难怪，我这边也断了一会儿」这种叙述当成承诺（实测误判）。
    if (PROMISE_DO_RE.test(t) && PROMISE_ACTION_RE.test(t) && !RETRO_RE.test(t)) {
      const key = `s:${summarize(t, 18)}`;
      if (!seen.has(key)) {
        seen.add(key);
        loops.push({
          owner: 'self', kind: 'promised', text: summarize(t),
          why: '你先前说过要看的/要做的', ageMs: age,
          weight: 0.7, evidence: t.slice(0, 80),
        });
      }
    }
  }

  // 越新越靠前；同类合并已做。
  // 再按"已经惦记过几次"降权：同一件事不该在每次唤醒里等权出现（永久惦记陷阱）。
  return applyFamiliarity(loops, seenLoops, now).slice(0, max);
}

/** 相似度（字符二元组 Jaccard），用于避免重复主动。 */
export function textSimilarity(a, b) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  const A = norm(a); const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const out = new Set();
    const chars = [...s];
    if (chars.length < 2) { out.add(s); return out; }
    for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
    return out;
  };
  const ga = grams(A); const gb = grams(B);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.max(1, ga.size + gb.size - hit);
}

export function isDuplicateText(text, history = [], threshold = 0.55) {
  return (Array.isArray(history) ? history : [])
    .some((h) => textSimilarity(text, h?.text ?? h?.purpose ?? '') >= threshold);
}

/**
 * 「这条惦记已经给她看过/说过几次」→ 降权系数。
 *
 * 为什么需要（照 surfcore 的 mergeGoal 教训）：
 *   素材在窗口里会一直存在，每轮算出同一件事。如果权重恒定，它就会在每次唤醒里
 *   反复出现，变成"永久惦记"——她每次醒来都被同一件 13 小时前的事绊住。
 *
 * 规则：看过 0 次 = 1.0；每多一次 ×0.55；≥4 次基本不进来（除非时间翻新）。
 */
export function familiarityFactor(entry, now = Date.now()) {
  const count = Math.max(0, Number(entry?.count) || 0);
  if (count === 0) return 1;
  const lastAt = Number(entry?.lastAt) || 0;
  const hoursSince = lastAt > 0 ? (now - lastAt) / HOUR : 0;
  const recency = Math.min(1, hoursSince / 24); // 一天内保持衰减，之后缓慢回升
  const base = Math.pow(0.55, count);
  return Math.min(1, base + recency * 0.35);
}

/** 排序前：按"已惦记过几次"降权，并过滤掉被看过太多次的。 */
export function applyFamiliarity(loops = [], seenLoops = {}, now = Date.now()) {
  const out = [];
  for (const l of (Array.isArray(loops) ? loops : [])) {
    const entry = seenLoops?.[l.text] ?? null;
    const f = familiarityFactor(entry, now);
    const weight = Number(l.weight) * f;
    if ((Number(entry?.count) || 0) >= 4 && weight < 0.35) continue;
    out.push({ ...l, weight, familiarity: Math.round((1 - f) * 100) / 100 });
  }
  out.sort((a, b) => b.weight - a.weight || a.ageMs - b.ageMs);
  return out;
}

// ── 提示词块 ────────────────────────────────────────────────────────────────

function ageText(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const h = n / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(n / 60000))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 纯附和：这种回话不构成"答过了"。 */
const PURE_ACK_RE = /^(嗯+|哦+|噢+|喔+|好+|行+|可以|收到|了解|明白|懂了|知道了|ok|okay|没问题|谢谢|多谢|感谢|辛苦了|哈哈+|hhh+|嘻嘻|草|艹|笑死|绝了|666|？+|\?+|在|嗯哼|确实|对的|是啊|是的|成|。) *$/i;

const KIND_HINT = {
  unanswered: '还没回他',
  followup: '可以问问进展',
  promised: '你先前说要做的',
};

/**
 * 生成注入唤醒提示词的「你心里惦记着」段落。
 *
 * 设计原则（照 surfcore 的教训）：
 *   · 只给「素材 + 倾向」，不替她决定；
 *   · 明确标注这是"不是任务"，允许她跳过；
 *   · 空的时候返回空串 —— 不产出没信息量的废话（契阔那次的教训）。
 */
export function buildIntentBlock({
  drives, loops = [], now = Date.now(), personaTraits = [], maxLoops = 3,
} = {}) {
  const lines = [];
  const tops = topNeeds(drives);

  if (loops.length) {
    lines.push('【你心里惦记着】');
    for (const l of loops.slice(0, maxLoops)) {
      const tag = GOAL_OWNER_LABELS[l.owner] ?? '';
      const hint = KIND_HINT[l.kind] ?? '';
      lines.push(`- ${l.owner === 'self' ? '' : (tag ? `[${tag}]` : '')}${l.text}（${ageText(l.ageMs)}${hint ? `，${hint}` : ''}）`);
    }
  }

  // 没有具体惦记的事时，只给倾向，不空写一个"惦记"标题（空标题是噪音）
  if (tops.length) {
    lines.push(`【此刻偏向】${tops.map((t) => `${t.label} ${t.score.toFixed(2)}`).join(' / ')}`);
    // 把最强的那个需要翻译成一句"想做什么"，比光给分数有用
    const intentText = {
      connect: '想找他说话，不是因为到点了，是想他了',
      care: '想问问他那件事怎么样了',
      share: '想给他看点/说点刚才想到的东西',
      curiosity: '有件事你还没弄明白，想问问他',
      play: '想拉他一起玩点什么，或者聊点没正形的',
    }[tops[0].need];
    if (intentText) lines.push(`（${intentText}。）`);
  }

  if (personaTraits.length && lines.length) {
    lines.push(`（这些来自你自己的记忆和人格，是"想说什么"的来源，不是任务清单；没兴趣就跳过。）`);
  } else if (lines.length) {
    lines.push('（不是任务清单，没兴趣就跳过。）');
  }

  if (!lines.length) return '';
  return `${lines.join('\n')}\n\n`;
}

/** 控制台/诊断用的一行摘要。 */
export function describeIntentState(drives) {
  const tops = topNeeds(drives, { min: 0.2, limit: 5 });
  return tops.map((t) => `${t.label}:${t.score.toFixed(2)}`).join(' ');
}
