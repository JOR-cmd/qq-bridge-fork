// 中文时间说法 → 日期区间（本地化自 dsh-silicon/src/when.ts，其源头是
// silicon-retention 的 memory.py:parse_when）。
//
// 为什么单独抽一个文件：
//   · 纯函数、零 I/O，可单测（test-when.mjs）
//   · recall.mjs 用它把「上周三」「8月3号」这类说法切成精确时间窗，
//     避免现在「按关键词搜全库、靠时间衰减碰运气」的粗放做法
//
// 日期一律用本地日历的 "YYYY-MM-DD" 字符串：按字典序比较就是按时间比较。
// ⚠️ 不按 UTC 解析用户说法（「昨天」对她说的是本地时间的昨天）。

export const WEEK = '一二三四五六日';
const CN_NUM = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };

const pad = (n) => String(n).padStart(2, '0');

/** 本地日历的日期（不是 UTC）。 */
export function dayOf(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 用本地日历算「今天 + n 天」，避免 UTC 偏移把「昨天」算成前天。 */
export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  const t = new Date(y, m - 1, d + n); // 本地构造，自动处理跨月/跨年
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 星期一 = 0 … 星期日 = 6（本地日历）。 */
export function weekday(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** 中文数字 → 整数（「十八」=18、「二十」=20、「两千」不在此列）。 */
export function cn2int(s) {
  const t = String(s ?? '');
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t.startsWith('十')) return 10 + (t.length > 1 ? CN_NUM[t.slice(1)] ?? 0 : 0);
  if (t.includes('十')) {
    const [a = '', b = ''] = t.split('十');
    return (CN_NUM[a] ?? 0) * 10 + (b ? CN_NUM[b] ?? 0 : 0);
  }
  return CN_NUM[t] ?? 0;
}

/** 合法日期才返回（2 月 30 日这类返回 null）。 */
function mk(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(y, m - 1, d);
  // 溢出（如 2 月 30 日会变成 3 月 2 日）→ 视为不存在的日期
  return t.getMonth() === m - 1 && t.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * 从一句话里找时间说法，返回 [起, 止] 日期闭区间（含首尾）；找不到返回 null。
 *
 * 覆盖（与 silicon 的 parse_when 逐条对应，顺序也一致）：
 *   2026-08-03 → 单日
 *   8月3号   → 当年单日
 *   上月 / 本月(初|上旬|中旬|下旬|底|末) → 月内区间
 *   大前天 / 前天 / 昨天 / 昨晚 → 单日
 *   N天前（含中文数字） → 单日
 *   上/上个/上上 周|星期|礼拜[一二三四五六日天] → 单日或整周
 *
 * ⚠️ 顺序有含义：先匹配更具体的写法（「2026-08-03」优先于「8月3号」），
 * 否则「8 月 3 号」可能被当成「本月 3 号」。
 */
export function parseWhen(text, nowDay) {
  const s = String(text ?? '');
  if (!s) return null;

  // ① 绝对日期 YYYY-MM-DD
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = mk(+m[1], +m[2], +m[3]);
    if (d) return [d, d];
  }

  // ② X月Y号（当年）
  m = s.match(/(\d{1,2}|[一二三四五六七八九十]+)月(\d{1,2}|[一二三四五六七八九十]+)[日号]/);
  if (m) {
    const d = mk(+String(nowDay).slice(0, 4), cn2int(m[1]), cn2int(m[2]));
    if (d) return [d, d];
  }

  // ③ 上/本月（含上旬等分档）
  m = s.match(/(上个?月|这个?月|本月)(初|上旬|中旬|下旬|底|末)?/);
  if (m) {
    const thisFirst = `${String(nowDay).slice(0, 7)}-01`;
    const first = m[1].startsWith('上') ? `${addDays(thisFirst, -1).slice(0, 7)}-01` : thisFirst;
    // 该月最后一天：下个月 1 号 - 1 天
    const nextMonthFirst = `${addDays(`${first.slice(0, 7)}-28`, 4).slice(0, 7)}-01`;
    const last = addDays(nextMonthFirst, -1);
    const lastDay = +last.slice(8);
    const parts = { 初: [1, 10], 上旬: [1, 10], 中旬: [11, 20], 下旬: [21, lastDay], 底: [21, lastDay], 末: [21, lastDay] };
    const [a, b] = parts[m[2] ?? ''] ?? [1, lastDay];
    return [`${first.slice(0, 8)}${pad(a)}`, `${first.slice(0, 8)}${pad(b)}`];
  }

  // ④ 大前天 / 前天 / 昨天 / 昨晚（顺序从远到近，避免「前天」被「昨天」抢走）
  for (const [w, n] of [['大前天', 3], ['前天', 2], ['昨天', 1], ['昨晚', 1]]) {
    if (s.includes(w)) {
      const d = addDays(nowDay, -n);
      return [d, d];
    }
  }

  // ⑤ N天前（阿拉伯或中文数字）
  m = s.match(/(\d+|[一二三四五六七八九十两]+)天前/);
  if (m) {
    const d = addDays(nowDay, -cn2int(m[1]));
    return [d, d];
  }

  // ⑥ 上周/上上周（可带星期几）
  const mon = addDays(nowDay, -weekday(nowDay));
  m = s.match(/(上上|上)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])?/);
  if (m) {
    const start = addDays(mon, -7 * (m[1] === '上上' ? 2 : 1));
    if (m[2]) {
      const d = addDays(start, '日天'.includes(m[2]) ? 6 : '一二三四五六'.indexOf(m[2]));
      return [d, d];
    }
    return [start, addDays(start, 6)];
  }

  return null;
}

/** 区间是否覆盖某个 epoch 毫秒。给 recall 过滤用。 */
export function dayRangeCovers([from, to], ms) {
  const d = dayOf(ms);
  return from <= d && d <= to;
}
