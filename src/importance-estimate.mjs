// 估算一条消息的初始 importance（0~1）。
//
// 为什么单独抽出来（2026-10-30）：
//   这个判据同时被两个地方用 —— archive-store 的新消息入库、backfill-importance 的历史回填。
//   写在两边必然会漂移（这项目已经踩过：preview-covenant 和 bridge 各写一份注入逻辑，
//   结果预览和实际不一致）。所以抽成一个纯函数，两边都调它。
//
// ── 判据的依据 ────────────────────────────────────────────────────────
// 用已经验证过的 emotion-pad 的 appraise —— 它跑过 896 条真实消息（命中 104 次），
// 是现成的、零额外成本的信号。有情绪的更可能"值得记"，符合记忆研究里的"情绪显著性"
// （memory-brain 的 surprisal.py:9-10 也明确写了这条）。
//
// ⚠️ 这是个**粗糙的起点**，不是完美判断：
//   实测「还有什么招，使出来吧」这种明显的情绪话拿不到分（词表没覆盖）。
//   真正的重要性要靠 access_count（被反复提起）来修正，那是动态的、更可靠的。
//
// ── 分值分配 ─────────────────────────────────────────────────────────
//   0.35  媒体占位符（[图片][表情]）—— 没有信息量
//   0.40  极短寒暄（≤4 字，如「嗯」「在吗」）
//   0.50  普通对话（默认值）
//   0.55~0.85  有情绪的话，按命中强度递增（上限 0.85，不给满分）
import { appraise } from './emotion-pad.mjs';

/** 媒体占位符：没有可记忆的内容 */
const MEDIA_RE = /^\[(图片|表情|拍一拍|语音|视频|动画表情|转发消息|位置|文件|名片|红包|视频通话)[^\]]*\]/;

/**
 * @param {string} text
 * @returns {number} 0.35 ~ 0.85
 */
export function estimateImportance(text) {
  const t = String(text ?? '');
  if (!t.trim()) return 0.5;

  // 媒体占位符优先判断：它可能带一点点文字，但主体是媒体
  if (MEDIA_RE.test(t.trim())) return 0.35;

  const hits = appraise(t);
  if (hits.length === 0) {
    // 无情绪：普通对话。极短的寒暄给更低分
    return t.length <= 4 ? 0.4 : 0.5;
  }
  // 有情绪：按命中强度加成。
  // appraise 返回的 dP 已经是 scale 后的值（0.6~1.0 倍），用它的绝对值做依据。
  const strength = hits.reduce((s, [, dp, da, dd]) => s + Math.abs(dp) + Math.abs(da) + Math.abs(dd), 0);
  return Number(Math.min(0.85, 0.55 + strength * 1.2).toFixed(3));
}
