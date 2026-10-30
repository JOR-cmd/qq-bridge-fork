// 契阔标记的「行为轨迹」：从她自己的行为里算出的事实，不涉及聊天内容。
//
// ── 这里删掉了什么（2026-10-28，第一版做错了）─────────────────────────────
//
// 第一版照 dsh-world 的 activity 思路，去统计「标记里的词，后来在他/她的消息里出现几次」。
// 实测结论：**这条在我们这里不成立**。
//
//   锚定到「原事件那条消息之后」再数：5 条标记全部是「他 0 次 / 她 0 次」。
//   也就是说她标完之后，他一次都没再提过 —— 统计量天然为空。
//
//   不锚定（从当天 0 点算）：能数出「他 5 次 / 她 7 次」，但那里面包含**原话本身** ——
//   拿事件验证事件，逻辑上等于零。
//
// 根因是前提不同：
//   · 作者的 note 是**承诺**（「我要把短词查询改好」），到点有可核对的结果，
//     而且「工具调用次数」是与他 note 完全独立、且每天几十上百的量。
//   · 我们的标记是**记录**（「他累成那样还先想着我」），没有「到点」这回事，
//     也不需要被验证 —— 它本来就是那一天的定格。
//
// 所以：**统计量差的不是精度，是两个数量级。** 这不是本地化能修的。
//
// ── 现在留下的是什么 ────────────────────────────────────────────────────
//
// 换数据源：不数聊天内容，数**她自己的行为**。这些是元数据，与标记内容零重叠，
// 不可能循环，也不需要她写任何判据：
//
//   · 这条标了几天（strength）
//   · 它现在还出现在她的信里吗（supported）
//   · 标它那天，信改过几版（版本化）
//
// 它们的价值是**长期的**，不是当下反馈：一条标了 20 天还在 → 真的重要；
// 标 1 天就消失 → 一时情绪；改过 5 版 → 一直没想清楚。
// 现在数据太少，这几句话几乎不产出信息 —— 半个月后才开始有意义。
import { markSupportedBy } from './covenant-store.mjs'

/**
 * 算一条标记的行为轨迹。
 *
 * @returns {{days:number, inLetters:number, lettersTotal:number, versionsOnDay:number, stillThere:boolean}}
 */
export function collectMarkTrail({ store, key, mark }) {
  const out = { days: 0, inLetters: 0, lettersTotal: 0, versionsOnDay: 0, stillThere: false }
  try {
    out.days = Math.max(0, Number(mark?.strength) || 0)
    const letters = store.letters(key, 30) || []
    out.lettersTotal = letters.length
    out.inLetters = letters.filter((l) => markSupportedBy(l.text, mark.text)).length
    out.stillThere = !!mark.supported
    if (mark.firstDay) {
      const versions = store.letterVersions(key, mark.firstDay) || []
      out.versionsOnDay = versions.length
    }
    return out
  } catch {
    return out // 算不出来就什么都不说，绝不影响唤醒
  }
}

/**
 * 把轨迹写成一句人话。**没有信息量时返回空串** —— 不摆一行废话给她看。
 *
 * 什么叫"没有信息量"：只标过 1 次、还在信里、那天也没改版。
 * 这时候说「你只标过 1 次，它还在信里」等于复述她自己刚做的事。
 */
export function formatMarkTrail(trail) {
  if (!trail) return ''
  const { days, inLetters, versionsOnDay, stillThere } = trail
  const bits = []
  if (days > 1) bits.push(`已经连着标了 ${days} 天`)
  if (!stillThere) bits.push('现在的信里已经没有它了')
  else if (days > 1 && inLetters > 1) bits.push(`它在你 ${inLetters} 封信里出现过`)
  if (versionsOnDay > 1) bits.push(`标它那天你的信改过 ${versionsOnDay} 版`)
  if (!bits.length) return ''
  return `${bits.join('，')}。`
}
