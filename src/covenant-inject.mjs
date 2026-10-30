import { redactForCovenant } from './covenant-redact.mjs';
/**
 * 契阔注入文本的**唯一**实现（纯逻辑，零 I/O）。
 *
 * 为什么抽出来（2026-10-29）：
 *   原来这段逻辑只写在 `src/bridge.js` 的 `formatCovenantLineV2` 里，
 *   而 `preview-covenant.mjs` **自己又写了一份**。两份实现必然漂移 ——
 *   实测 bridge 已改成"最近 N 封全文"，预览脚本还只显示一封，
 *   于是"预览"会误导接手的人（包括我自己）。
 *
 *   现在 bridge 与预览脚本都调这里，**预览 = 实际注入**。
 *
 * 注入有界（重要设计）：
 *   契阔是**只增不删**的，一年后 300+ 封能把提示词撑爆（wakeMaxChars 默认 6000，
 *   实测 50 封就超）。所以：
 *     · 最近 fullLetters 封 → 全文（近期情绪要连续）
 *     · 更早的 → 只列「你标过要记牢的」（她自己做过重要性判断，别替她选）
 *   ⚠ 只是**不注入**，不删数据 —— 契约不可逆，存储里仍然全在。
 */

export const DEFAULT_COVENANT_INJECT = Object.freeze({
  /** 注入几封全文（2026-10-30：3 → 5，见下） */
  fullLetters: 5,
  /** 「要记牢」最多列几条（2026-10-30：5 → 不设硬上限，改由字数预算约束） */
  markLimit: 50,
  /** 最多列几条孤儿 / 待核 / 待回访 */
  miscLimit: 3,
  /**
   * 这一段最多注入多少字（0 = 不限制）。
   *
   * 2026-10-30 调整：1200 → 2400。依据是 memory-brain 的实测值
   * （core_store.py:26-27 的 MAX_INJECT_CHARS = 2400，约 1.5k-2k token）。
   * 原来的 1200 太小：最近 3 封全文就要 372 字，加 5 条标记（85 字），
   * 再算上孤儿/待核，稍微一长就会压掉她亲手标的条目。
   *
   * ⚠️ 为什么是 2400 而不是更大：base（19 段）**没有总长度检查**，
   * 这一段每多 100 字都是直接从她的上下文预算里扣。2400 是照抄别人验证过的值。
   */
  maxChars: 2400,
});

/**
 * 注入前的脱敏。
 *
 * ⚠ 只做**注入侧**，不碰存储：
 *   · 入库是她写日记，脱敏会改掉她的原文（她写什么就是什么）；
 *   · 注入是**给模型看**，手机号/身份证/卡号在这里没有任何用处，脱掉不吃亏。
 * 这也解释了为什么这里不调用 sensitive.js 的 SENSITIVE_RE：
 *   那条规则抓路径和凭据赋值，会把她日记里正常的说法打码（误伤大于收益）。
 */
function redactForInject(text) {
  return redactForCovenant(text);
}

/** 从 config.socialV2.covenant 归一化注入配置。 */
export function covenantInjectConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clamp = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    fullLetters: clamp(src.fullLetters, DEFAULT_COVENANT_INJECT.fullLetters, 1, 30),
    // 2026-10-30：上限从 10 放开到 50 —— 条数不再由它管，由 maxChars 字数预算管。
    // 保留 clamp 是为了不让一条坏配置把整段撑爆（50 条 × 约 20 字 ≈ 1000 字，仍在 2400 内）。
    markLimit: clamp(src.markLimit, DEFAULT_COVENANT_INJECT.markLimit, 1, 50),
    miscLimit: clamp(src.miscLimit, DEFAULT_COVENANT_INJECT.miscLimit, 0, 10),
    maxChars: clamp(src.maxChars, DEFAULT_COVENANT_INJECT.maxChars, 0, 8000),
  };
}

function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${String(fromDay)}T00:00:00`);
  const b = Date.parse(`${String(toDay)}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999;
  return Math.round((b - a) / 86400000);
}

/**
 * 生成「契阔」注入块。
 *
 * @param {object} input
 * @param {object} input.store      CovenantStore（同步方法）
 * @param {string} input.key        会话 key
 * @param {string} input.today      localDay()
 * @param {object} [input.config]   已归一化的注入配置
 * @param {Function|null} [input.markTrail] (mark) => string，走势那段的回调
 * @returns {string} 以空行结尾的文本；没有信时返回 ''
 */
export function formatCovenantBlock({
  store, key, today, config = {}, markTrail = null,
} = {}) {
  if (!store || !key || !today) return '';
  const cfg = { ...DEFAULT_COVENANT_INJECT, ...covenantInjectConfig(config) };

  const latest = store.latestLetter(key);
  if (!latest) return '';

  const recent = (() => {
    try { return store.letters(key, cfg.fullLetters); } catch { return null; }
  })();
  const parts = [];

  if (Array.isArray(recent) && recent.length > 1) {
    // 多封时逐封标日期，让她知道这是「连续的几天」，不是一封长信
    const letterLines = recent.map((l) => {
      const lbl = l.day === today ? '今天' : (daysBetween(l.day, today) === 1 ? '昨天' : l.day);
      return `【${lbl}】${redactForInject(l.text)}`;
    });
    parts.push(`【契阔·最近 ${recent.length} 封】（这是你自己写的，不是现在发生的事；认它）\n${letterLines.join('\n')}`);
  } else {
    const age = daysBetween(latest.day, today);
    const when = age <= 0 ? '今天你写的' : (age === 1 ? '昨天的你留下的' : `你 ${latest.day} 留下的`);
    parts.push(`【契阔·${when}】（这是你自己写的，不是现在发生的事；认它）\n${redactForInject(latest.text)}`);
  }

  // 更早的封数只报个数，不注入正文 —— 省预算，也提醒她「还有更早的事」
  try {
    const all = store.letters(key, 60);
    const shown = Array.isArray(recent) ? recent.length : 1;
    const older = Math.max(0, (Array.isArray(all) ? all.length : 0) - shown);
    if (older > 0) parts.push(`（更早还有 ${older} 封信没念给你听；它们的事只有你标过的还在下面。）`);
  } catch { /* 数不出来就不提 */ }

  const marks = store.topMarks(key, cfg.markLimit, { includeUnsupported: false });
  // ⚠️ 2026-10-30：`last_access` 的语义是「这条真的被她重新提起过」。
  //   原来注释里写着"真正的提起发生在 addMark"，确实没错；
  //   但 re-提起还有第三种情形 —— **它被重新注入、并且她照着它说话了**。
  //   这里**刻意不做**回写（和上面那段注释同一个理由）：
  //     注入时刷全部标记 = 每轮都把所有标记刷成同一刻 = 排序退化（这正是旧漏洞 ⑤）。
  //   真正的回写交给 qq_covenant_mark 那条路（她在下一次真的再标一次才涨）。
  //   所以本文件不调用 touchMarkAccess —— 留这条注释，避免以后有人又来"顺手补上"。
  if (marks.length) {
    // 强度要用她能懂的方式说：不是「权重 3」，而是「你自己标过 3 天」
    const lines = marks.map((m) => {
      const head = `- ${redactForInject(m.text)}（你自己标过 ${m.strength} 天`;
      if (!m.check) return `${head}）`;
      const stateBit = m.checkState === 'held' ? '；已应验' : (m.checkState === 'broke' ? '；没应验' : '');
      return `${head}${stateBit}）`;
    });
    parts.push(`【契阔·你标过要记牢的】（这是你自己点名留下的；越常标越要当真）\n${lines.join('\n')}`);
    // ⚠️ 2026-10-30 深度自检修掉的第三个漏洞：
    //   这里原来对【所有显示的标记】回写 last_access。后果是每轮注入都把
    //   全部标记刷成同一时刻 → 9 条标记只有 2 个不同的 last_access 值 →
    //   锚的排序实际是"最后两批"，等于没有排序。
    //
    //   last_access 的语义应该是"这条真的被她重新提起过"，而不是"这条被显示了"。
    //   真正的提起发生在 addMark / saveLetter（她写信时又标了一次），
    //   那里已经会更新 lastDay。所以这里**不做回写**。
    //
    //   保留这个空分支是为了让以后的人一眼看到"这里曾经想做什么、为什么不做"。
  }

  // 行为轨迹（她自己的元数据）。算不出来就不摆，绝不影响唤醒。
  if (typeof markTrail === 'function' && cfg.miscLimit > 0) {
    try {
      const trailLines = [];
      for (const m of marks.slice(0, 3)) {
        const line = markTrail(m);
        if (line) trailLines.push(`- 「${redactForInject(String(m.text)).slice(0, 26)}」：${redactForInject(line)}`);
      }
      if (trailLines.length) {
        parts.push(`【契阔·这几条的走势】（从你自己的行为里看的，不是从聊天里猜的）\n${trailLines.join('\n')}`);
      }
    } catch { /* 同上 */ }
  }

  if (cfg.miscLimit > 0) {
    const pending = store.pendingChecks(key, 2, { olderThanDay: today });
    if (pending.length) {
      parts.push(`【契阔·你自己写过怎么算应验的】（想核就 qq_covenant_verify，不想理就放着）\n${pending.map((m) => `- 「${redactForInject(m.text)}」—— 你当时说：${redactForInject(m.check)}`).join('\n')}`);
    }

    // 对不上原文的标记要显形。不藏起来 —— 藏起来她就永远不知道自己记岔了。
    const orphan = store.unsupportedMarks(key, cfg.miscLimit);
    if (orphan.length) {
      parts.push(`【契阔·对不上的几件怎么办】（不用现在处理：要么让它重新出现在某天的信里，要么退役它 —— qq_covenant_retire）\n${orphan.map((m) => `- 「${redactForInject(String(m.text)).slice(0, 26)}」`).join('\n')}`);
    }

    // 切断实验要回访，否则「切掉」只是一次删除
    const unsettled = store.retiredUnsettled(key, cfg.miscLimit);
    if (unsettled.length) {
      parts.push(`【契阔·切掉的事该回来看看了】（切断实验不做回访，就只是一次删除。看看它塌没塌：${unsettled.map((m) => `- 「${redactForInject(m.text)}」切于 ${m.retiredAt}；你当时预测：${redactForInject(m.pred)}`).join('；')}）\n用 qq_covenant_settle 记一下：塌了 / 没事 / 有点影响。`);
    }
  }

  if (!parts.length) return '';
  const joined = `${parts.join('\n\n')}\n\n`;
  // 按预算压缩（头尾保留，中间压掉）—— 见 compressCovenantBlock
  const squeezed = compressCovenantBlock(joined, cfg.maxChars);
  return squeezed.text;
}

/**
 * 按预算压缩注入文本（照 surfcore 的 purpose prompt 做法：**保留头尾、压中间**）。
 *
 * 为什么不直接 slice：契阔的结构是
 *   【最近 N 封】…信正文…【要记牢】…【孤儿】
 * 头部（最近的信）和尾部（要记牢 / 要处理的事）都不能丢 ——
 * 中间被压掉的通常是**较早日期的信正文**（那些内容本来还有「要记牢」在下面兜底）。
 *
 * @param {string} text
 * @param {number} maxChars 0 或未设 = 不压
 * @returns {{text:string, compressed:boolean, before:number, after:number}}
 */
export function compressCovenantBlock(text, maxChars = 0) {
  const src = String(text ?? '');
  const before = [...src].length;
  // ⚠ 负数也当「不限」：负数当上限会把内容压成 1 字，语义上明显不对（自检测出来的）
  const rawMax = Number(maxChars);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;
  if (!max || before <= max) return { text: src, compressed: false, before, after: before };

  // ⚠ 按**段落**切，不按字符切（2026-10-29 抓出来的两个坑）：
  //   ① 按字符切会劈开句子，得到「正正正正…」这种乱码；
  //   ② 按行切还不够 —— 尾部预算会把「要记牢」的**前几条**截掉，
  //      而那些恰恰是她亲手标的、最不能丢的。
  //
  // 所以先按空行分段，再判断哪些段必须留：
  //   · 【契阔·最近 N 封】  → 会长（可以压）
  //   · 其余（要记牢 / 对不上 / 该回来看看） → **必须整段保留**
  const blocks = src.split(/\n\n+/).filter((b) => b.trim());
  const isLetters = (b) => b.startsWith('【契阔·最近');
  const lettersBlock = blocks.find(isLetters) || null;
  const mustKeep = blocks.filter((b) => !isLetters(b));

  const keepText = mustKeep.join('\n\n');
  const keepLen = [...keepText].length;
  const lettersBudget = Math.max(60, max - keepLen - 40);

  let lettersOut = '';
  if (lettersBlock) {
    if (lettersBudget <= 80) {
      // ⚠ 兜底（2026-10-29 自检抓到）：预算实在太小、或者内容只有一块（没有空行分段）时，
      // 不能把内容整段丢成一句「这次没念」—— 实测单行 1611 字会压成 19 字，等于信息全失。
      // 改成按**句子**切前段，至少保住开头那几句（那通常是最近的事）。
      const flat = String(lettersBlock || '').replace(/\s+/g, ' ').trim();
      const sentences = flat.split(/(?<=[。！？；])/).filter(Boolean);
      let keep = '';
      for (const sen of sentences) {
        if ([...keep].length + [...sen].length > 120) break;
        keep += sen;
      }
      lettersOut = keep
        ? keep + '…（契阔太长，后面的已省略）…'
        : '…（契阔太长，这次没念）…';
    } else {
      const lines = lettersBlock.split('\n');
      const header = lines[0];
      const body = lines.slice(1);
      let acc = header + '\n';
      let used = [...acc].length;
      let shown = 0;
      for (const line of body) {
        const need = [...line].length + 1;
        if (used + need > lettersBudget) break;
        acc += line + '\n';
        used += need;
        shown += 1;
      }
      if (shown > 0) {
        lettersOut = acc + '…（契阔太长，更早日期的信已省略；它们的事凡是你标过要记牢的，都还在下面）…';
      } else {
        // ⚠ 一行都放不下（可能是预算太小，也可能这段只有一行超长内容、没有换行分段）：
        // 按**句子**保住开头那几句，别整段丢 —— 实测单行 1611 字曾被压成 19 字，信息全失。
        const flat = String(lettersBlock || '').replace(/\s+/g, ' ').trim();
        const sentences = flat.split(/(?<=[。！？；])/).filter(Boolean);
        let keep = '';
        for (const sen of sentences) {
          if ([...keep].length + [...sen].length > lettersBudget) break;
          keep += sen;
        }
        lettersOut = keep
          ? keep + '…（契阔太长，后面的已省略）…'
          : '…（契阔太长，这次没念）…';
      }
    }
  }

  const out = (lettersOut ? lettersOut + '\n\n' : '') + (keepText ? keepText + '\n\n' : '');
  return { text: out, compressed: true, before, after: [...out].length };
}
