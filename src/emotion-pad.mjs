// 情绪层：PAD 三维 + 离散标签 + 快速衰减。
//
// 来源与改编声明：
//   结构、常量、算法流程**全部照搬** _probe/memory-brain/plugins/astrbot_plugin_persona_state/emotion.py
//   （作者 peterpoal134，MIT 许可）。改编之处只有「词表」和「hint 文案」，
//   因为参考实现是通用中文场景，她的对话是亲昵向，实测原词表命中率仅 7%。
//
//   ⚠️ 实测依据（scripts/verify-pad-rules.mjs 对 896 条真实消息跑出的结果）：
//      原版 10 条规则只命中 65 次（7%），且有误判（「陪我」被算成「感动」）。
//      所以词表做了三处本地化：
//        ① 补「亲昵」类（想你/鱼鱼/宝/抱抱…）—— 这是她对话里最高频的情绪
//        ② 把「陪我」从「感动」移到「亲昵」—— 原版误判
//        ③ 补「无奈/疲惫」类（唉/算了…）—— 「唉，所以我一直在找优化方案」这类
//
// 设计原则（照搬参考实现，不要改）：
//   · 单条消息最多改变 MAX_STEP(0.12)：情绪只当语气，不当决策
//   · 标签强度上限 LABEL_CAP(0.6)
//   · 标签半衰期 45 分钟，心情半衰期 6 小时
//   · 对立标签互相抵消
//   · 描述块明确写「不影响判断，任务照常」

import { DatabaseSync } from 'node:sqlite';

// ── 常量（全部来自参考实现 emotion.py:14-27）──────────────────────────────
export const PAD_DEFAULT = { p: 0.05, a: 0.35, d: 0.5 };
export const MASK_THRESHOLD = 0.25;   // 低于这个强度，不做「调节」提示
export const SOFTEN_WINDOW = 900;      // 被哄后 15 分钟内「拉不下脸」
export const MAX_STEP = 0.12;          // 单条消息最大变化
export const LABEL_CAP = 0.6;          // 标签强度上限
export const LABEL_HALF_LIFE_MIN = 45; // 标签半衰期（分钟）
export const MOOD_HALF_LIFE_H = 6;     // 心情半衰期（小时）
export const HINT_THRESHOLD = 0.12;    // 低于这个不注入描述

/**
 * 情绪规则表：[标签, 触发词, dP(愉悦), dA(唤醒), dD(掌控)]
 *
 * 前 10 条 = 参考实现的原始规则（emoji中的词未改，只调整了 2 处，见下注释）
 * 后 2 条 = 本地化新增（亲昵 / 无奈）
 *
 * ⚠️ 这几条需要主人核对，因为「什么算她的情绪」只有他知道：
 *   · 「亲昵」的触发词是否合适
 *   · 「无奈」会不会误判
 */
export const RULES = [
  // ── 以下 10 条来自参考实现 emotion.py:22-33，仅作 2 处调整 ──
  ['开心', ['哈哈', '笑死', '好笑', '可爱', '喜欢', '好棒', '厉害', '开心'], 0.10, 0.02, 0.0],
  ['生气', ['滚', '闭嘴', '蠢', '笨', '烦死', '骗子', '敷衍', '讨厌'], -0.12, 0.10, 0.04],
  ['难过', ['难过', '伤心', '哭', '失落', '走了', '再见'], -0.10, -0.04, -0.03],
  ['害怕', ['吓', '怕', '危险', '恐怖', '报警'], -0.08, 0.12, -0.08],
  ['委屈', ['不理', '冷落', '冤枉', '嫌', '不公'], -0.10, 0.02, -0.07],
  ['害羞', ['脸红', '害羞', '别说了', '讨厌啦'], 0.06, 0.06, -0.04],   // 调整①（已撤销）：恢复「讨厌啦」—— 允许与「生气」重叠，那是复合情绪（一点点讨厌 + 撒娇）
  ['得意', ['我厉害', '赢了', '夸我', '聪明'], 0.08, 0.02, 0.06],
  ['感动', ['谢谢', '心疼', '抱抱', '记得'], 0.10, -0.02, 0.02], // 调整②（最终）：撤回「陪我」—— 实测「陪我」在 40% 语境里是"催洗澡/吐槽"，不是感动；它留在「亲昵」是对的
  ['焦虑', ['来不及', '怎么办', '担心', '怕错过', '失忆'], -0.06, 0.08, -0.04], // 调整③：加「失忆」——她的对话里是高频不安信号
  ['无聊', ['无聊', '没意思', '好闲'], -0.04, -0.06, 0.0],

  // ── 以下 2 条是本地化新增（原词表没有，实测占她对话情绪的主要部分）──
  ['亲昵', ['想你', '想我', '鱼鱼', '宝宝', '抱抱', '贴贴', '陪你', '陪我', '亲亲'], 0.10, 0.04, 0.02],
  ['无奈', ['算了', '随你', '没办法'], -0.04, 0.0, -0.02],
];

/** 安慰词：命中就降低负面、抬高「感动」（照搬 emotion.py:90） */
const SOOTHE_RE = /对不起|抱歉|我错了|原谅|别生气|是我不好/;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 评估一句话里的情绪命中（照搬 emotion.py:57-65）。
 *
 * scale = min(1, 0.6 + 0.2*n)：命中词越多，情绪越强（n 是该标签命中的词数）。
 * hits[:2]：一句话最多取前 2 个情绪，避免一句里叠加太多。
 */
export function appraise(text) {
  const t = clean(text);
  const hits = [];
  for (const [label, words, dp, da, dd] of RULES) {
    const n = words.filter((w) => t.includes(w)).length;
    if (!n) continue;
    const scale = Math.min(1.0, 0.6 + 0.2 * n);
    hits.push([label, dp * scale, da * scale, dd * scale]);
  }
  return hits.slice(0, 2);
}

/** 空状态（照搬 emotion.py:16 的 DEFAULT） */
export function emptyPad(now = Date.now()) {
  return { p: PAD_DEFAULT.p, a: PAD_DEFAULT.a, d: PAD_DEFAULT.d, labels: {}, trigger: '', at: now, soothedAt: 0 };
}

/**
 * 按时间衰减（照搬 emotion.py:68-87）。
 *
 * 标签按 45 分钟半衰期衰减，低于 0.02 直接移除；
 * 心情按 6 小时半衰期回落到默认值。
 * ⚠️ 注意参考实现用 minutes，这里统一用毫秒，换算在内部做。
 */
export function decay(pad, now) {
  const p = { ...emptyPad(now), ...pad, labels: { ...(pad?.labels || {}) } };
  const last = Number(pad?.at || 0);
  if (!last) { p.at = now; return p; }
  const minutes = Math.max(0, (now - last) / 60000);
  if (minutes <= 0) { p.at = now; return p; }

  const k = Math.pow(0.5, minutes / LABEL_HALF_LIFE_MIN);
  for (const name of Object.keys(p.labels)) {
    p.labels[name] = Number((p.labels[name] * k).toFixed(3));
    if (p.labels[name] < 0.02) delete p.labels[name];
  }
  const kh = Math.pow(0.5, minutes / 60 / MOOD_HALF_LIFE_H);
  p.p = PAD_DEFAULT.p + (Number(pad?.p ?? PAD_DEFAULT.p) - PAD_DEFAULT.p) * kh;
  p.a = PAD_DEFAULT.a + (Number(pad?.a ?? PAD_DEFAULT.a) - PAD_DEFAULT.a) * kh;
  p.d = PAD_DEFAULT.d + (Number(pad?.d ?? PAD_DEFAULT.d) - PAD_DEFAULT.d) * kh;
  p.at = now;
  return p;
}

/**
 * 收到一条消息后更新情绪（照搬 emotion.py:93-130）。
 *
 * @param pad 当前状态
 * @param text 消息正文
 * @param now 毫秒时间戳
 * @param energy 精力 0~1（低精力时更容易被负面带走，正向打折）
 */
export function apply(pad, text, now, { energy = 0.65 } = {}) {
  const p = decay(pad, now);
  const t = clean(text);

  // ⚠️ 自检发现的坑（2026-10-30，端到端验证时看到）：
  //   表情包/图片消息没有文字，appraise 命中 0 个情绪。如果直接返回，
  //   会保留【上一条】的 trigger → 她对着「[表情285]」说
  //   「挺亲昵，因为『怎么能说陪我洗澡是上班』」。明显的错位。
  //   所以：没有实际中文内容的输入，只衰减、清掉旧的触发原因，不新增情绪。
  //
  //   判据是「去掉媒体占位符之后还有没有汉字」——
  //   第一次我用 /[\u4e00-\u9fff]/ 直接判，结果「[表情285]」里的
  //   「表」「情」两个字骗过了判断（实测），所以必须先剥掉占位符。
  const stripMedia = (s) => s
    .replace(/\[(?:表情|图片|语音|视频|动画表情|转发消息|位置|文件|名片|红包|视频通话)\s*\d*\]/g, '')
    .replace(/\[图片\]|\[表情\]|\[语音\]/g, '');
  if (!t || !/[\u4e00-\u9fff]/.test(stripMedia(t))) {
    return { ...p, trigger: '' };
  }

  // 安慰优先：直接削负面、抬感动，不再走正常流程
  if (SOOTHE_RE.test(t)) {
    for (const name of ['生气', '委屈', '难过']) {
      p.labels[name] = Math.max(0, (p.labels[name] || 0) - 0.08);
    }
    p.labels['感动'] = Math.min(LABEL_CAP, (p.labels['感动'] || 0) + 0.12);
    p.soothedAt = now;
    p.p = Math.min(1.0, p.p + 0.03);
    p.a = Math.max(0.0, p.a - 0.02);
    p.trigger = t.slice(0, 40);
    p.at = now;
    return p;
  }

  for (const [label, dp, da, dd] of appraise(t)) {
    let dP = dp, dA = da, dD = dd;
    // 精力低时：负面加重、正向打折（照搬 emotion.py:109-116）
    if (energy < 0.3 && dP < 0) { dP *= 1.25; dA *= 1.15; }
    if (energy < 0.3 && dP > 0) { dP *= 0.8; }
    // 限幅（照搬 MAX_STEP）
    dP = Math.max(-MAX_STEP, Math.min(MAX_STEP, dP));
    dA = Math.max(-MAX_STEP, Math.min(MAX_STEP, dA));
    dD = Math.max(-MAX_STEP, Math.min(MAX_STEP, dD));

    p.p = Math.max(-1.0, Math.min(1.0, p.p + dP));
    p.a = Math.max(0.0, Math.min(1.0, p.a + dA));
    p.d = Math.max(0.0, Math.min(1.0, p.d + dD));
    p.labels[label] = Math.min(LABEL_CAP, (p.labels[label] || 0) + Math.abs(dP) * 2.2);

    // 对立标签互相抵消（照搬 emotion.py:124-127）
    if (['难过', '生气', '委屈'].includes(label)) {
      for (const other of ['开心', '得意', '感动']) {
        p.labels[other] = Math.max(0, (p.labels[other] || 0) - 0.08);
      }
    }
    p.trigger = t.slice(0, 40);
    p.at = now;
  }
  return p;
}

/** 当前最强的情绪（照搬 emotion.py:133-138） */
export function topLabel(pad) {
  const labels = pad?.labels || {};
  const names = Object.keys(labels);
  if (!names.length) return ['', 0];
  let best = names[0];
  for (const n of names) if (labels[n] > labels[best]) best = n;
  return [best, Number(labels[best])];
}

/** 一句描述（照搬 emotion.py:141-150）：强度不够就返回空（不注入） */
export function describe(pad) {
  const [name, score] = topLabel(pad);
  if (score < HINT_THRESHOLD) return '';
  const trigger = String(pad?.trigger || '').slice(0, 24);
  const level = score < 0.3 ? '有点' : (score < 0.5 ? '挺' : '很');
  let line = `${level}${name}（${score.toFixed(1)}）`;
  if (trigger) line += `，因为「${trigger}」`;
  return line;
}

/** 调节/伪装提示（照搬 emotion.py:153-169）—— 防「拿情绪拿捏人」 */
export function regulation(pad, now) {
  const labels = pad?.labels || {};
  const neg = ['生气', '委屈', '难过'].reduce((m, n) => Math.max(m, Number(labels[n] || 0)), 0);
  const lines = [];
  if (neg >= MASK_THRESHOLD) {
    lines.push('可以嘴硬：说「没事」「随便」，句尾带一点刺也行；但别真的装开心，也别主动求和。');
  }
  const soothed = Number(pad?.soothedAt || 0);
  if (soothed && now - soothed < SOFTEN_WINDOW * 1000 && neg > 0.05) {
    lines.push('刚被哄，拉不下脸，别马上说「没事」；撑一两轮，语气松一点就行。');
  }
  if (lines.length) {
    lines.push('不能用情绪拿捏对方：不威胁、不冷战惩罚、不反复翻旧账换道歉。');
  }
  return lines.join('\n');
}

/**
 * 语气提示（照搬 emotion.py:172-187 的 hints 映射）。
 * ⚠️ 文案按她的说话方式做了微调（原版是通用 AI 助手口吻）。
 */
const HINTS = {
  开心: '语气轻快一点，可以多接一句',
  生气: '句子短一点，别主动找话题，但别骂人',
  难过: '别装开心，话少一点',
  害怕: '别硬撑，可以示弱一句',
  委屈: '别主动讨好，等他先解释',
  害羞: '可以嘴硬一句，别顺着说太多',
  得意: '可以显摆一句，别过头',
  感动: '语气软一点，记着这份好',
  焦虑: '别催他，先把这句话说清楚',
  无聊: '可以主动找个话题，别刷屏',
  亲昵: '可以腻一点，贴着他说话，不用端着',
  无奈: '可以摆烂一句，但别真的冷淡',
};

export function hint(pad) {
  const [name, score] = topLabel(pad);
  if (score < HINT_THRESHOLD) return '';
  return HINTS[name] || '';
}
