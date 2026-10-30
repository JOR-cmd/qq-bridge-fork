// PAD 情绪层回归（不联网、不碰真实 state/）。
// 用法：node test-emotion-pad.mjs
//
// 覆盖：appraise 命中 / scale 计算 / hits[:2] 截断 / decay 半衰期 /
//       apply 限幅 / 对立抵消 / 安慰修复 / describe 阈值 / 词表不误伤
import {
  RULES, appraise, apply, decay, emptyPad, describe, regulation, hint, topLabel,
  MAX_STEP, LABEL_CAP, HINT_THRESHOLD, LABEL_HALF_LIFE_MIN, MOOD_HALF_LIFE_H, PAD_DEFAULT,
} from './src/emotion-pad.mjs';

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log('\n[1] appraise：命中与强度');
{
  ck('单个词命中 1 个标签', appraise('想你了').length === 1, JSON.stringify(appraise('想你了')));
  ck('命中标签是「亲昵」', appraise('想你了')[0]?.[0] === '亲昵');
  // scale = min(1, 0.6 + 0.2*n)：命中 1 词 → 0.8；2 词 → 1.0
  const one = appraise('我好开心');
  ck('1 个词 scale=0.8 → dP=0.08', Math.abs(one[0][1] - 0.08) < 1e-9, String(one[0][1]));
  const two = appraise('哈哈 笑死');
  ck('2 个词 scale=1.0 → dP=0.10', Math.abs(two[0][1] - 0.10) < 1e-9, String(two[0][1]));
  ck('无命中返回空数组', appraise('今天天气不错').length === 0);
  ck('空串不抛', appraise('') .length === 0);
  ck('null 不抛', appraise(null).length === 0);
}

console.log('\n[2] 一句话最多取 2 个情绪');
{
  const t = '我好开心，可是又有点委屈，还害怕';
  const hits = appraise(t);
  ck('命中数 ≤2', hits.length <= 2, JSON.stringify(hits.map(h => h[0])));
}

console.log('\n[3] 词表：主人核对过的项');
{
  ck('「宝宝」识别为亲昵', appraise('宝宝').some(h => h[0] === '亲昵'));
  ck('「亲亲」识别为亲昵', appraise('亲亲').some(h => h[0] === '亲昵'));
  ck('「贴贴」识别为亲昵', appraise('贴贴').some(h => h[0] === '亲昵'));
  // 已去掉的词不该再命中
  ck('「唉」不再触发无奈', !appraise('唉').some(h => h[0] === '无奈'), JSON.stringify(appraise('唉')));
  ck('「哎」不再触发无奈', !appraise('哎').some(h => h[0] === '无奈'));
  // 「陪我」的最终归属（2026-10-30 主人决定）：
  //   只在「亲昵」里，不在「感动」里。
  //   理由：实测「陪我」在绝大多数语境是"催洗澡/吐槽/想一起"，不是"感动"；
  //   加回「感动」会让 40% 的消息被误标成感动（已实测）。
  ck('「陪我」只归亲昵，不归感动', (() => {
    const h = appraise('陪我').map((x) => x[0]);
    return h.includes('亲昵') && !h.includes('感动');
  })(), JSON.stringify(appraise('陪我').map(h => h[0])));
  // 但「讨厌啦」是真复合（生气 一点点 + 害羞 撒娇），要保留叠加
  ck('「讨厌啦」同时触发生气与害羞（真复合）', (() => {
    const h = appraise('讨厌啦').map((x) => x[0]);
    return h.includes('生气') && h.includes('害羞');
  })(), JSON.stringify(appraise('讨厌啦').map(h => h[0])));
  ck('「失忆」识别为焦虑', appraise('你会失忆吗').some(h => h[0] === '焦虑'));
}

console.log('\n[4] decay：半衰期');
{
  const now = Date.now();
  let pad = emptyPad(now);
  pad.labels['开心'] = 0.6;
  pad.at = now;
  // 45 分钟后应衰减到一半
  const after45 = decay(pad, now + 45 * 60000);
  ck('标签 45 分钟后约减半', Math.abs(after45.labels['开心'] - 0.3) < 0.02, String(after45.labels['开心']));
  // 低于 0.02 会被移除
  const afterLong = decay(pad, now + 45 * 60000 * 6);
  ck('衰减到 0.02 以下被移除', afterLong.labels['开心'] === undefined, JSON.stringify(afterLong.labels));
  // 心情按 6 小时回默认
  const p2 = { ...pad, p: 0.5, at: now };
  const after6h = decay(p2, now + 6 * 3600 * 1000);
  ck('心情 6 小时后回落到中间值', Math.abs(after6h.p - (PAD_DEFAULT.p + (0.5 - PAD_DEFAULT.p) * 0.5)) < 0.01, String(after6h.p));
}

console.log('\n[5] apply：限幅与累积');
{
  const now = Date.now();
  let pad = emptyPad(now);
  // 连续说 20 次极端负向的话，dP 每次被限到 -0.12
  for (let i = 0; i < 20; i++) pad = apply(pad, '烦死 骗子 敷衍', now + i * 1000);
  ck('p 不会跌破 -1', pad.p >= -1.0, String(pad.p));
  ck('a 不会超过 1', pad.a <= 1.0, String(pad.a));
  ck('标签强度不超过 LABEL_CAP', Object.values(pad.labels).every(v => v <= LABEL_CAP + 1e-9), JSON.stringify(pad.labels));
}

console.log('\n[6] 对立标签抵消');
{
  const now = Date.now();
  let pad = emptyPad(now);
  pad = apply(pad, '我好开心', now);
  const before = pad.labels['开心'] || 0;
  pad = apply(pad, '我很生气', now + 1000);
  ck('生气会削弱开心', (pad.labels['开心'] || 0) < before, `${before} → ${pad.labels['开心']}`);
}

console.log('\n[7] 安慰修复');
{
  const now = Date.now();
  let pad = emptyPad(now);
  pad = apply(pad, '你怎么不理我', now);          // 委屈
  const negBefore = pad.labels['委屈'] || 0;
  pad = apply(pad, '对不起 是我错了', now + 1000); // 安慰
  ck('安慰降低委屈', (pad.labels['委屈'] || 0) < negBefore, `${negBefore} → ${pad.labels['委屈']}`);
  ck('安慰抬高感动', (pad.labels['感动'] || 0) > 0, JSON.stringify(pad.labels));
  ck('记下被哄时间', pad.soothedAt > 0);
}

console.log('\n[8] describe / hint / regulation');
{
  let pad = emptyPad(Date.now());
  ck('情绪弱时不描述', describe(pad) === '', describe(pad));
  ck('情绪弱时无 hint', hint(pad) === '');
  pad.labels['委屈'] = 0.4; pad.trigger = '他说我像机器';
  const d = describe(pad);
  ck('情绪强时有描述', d.includes('委屈') && d.includes('挺'), d);
  ck('描述带触发原因', d.includes('像机器'), d);
  ck('hint 非空', hint(pad).length > 0, hint(pad));
  // 负面 ≥ 阈值 → 有调节提示
  ck('负面高时有调节提示', regulation(pad, Date.now()).includes('嘴硬'), regulation(pad, Date.now()));
  // 恰到「不能拿捏对方」这条硬约束
  ck('调节提示含「不能用情绪拿捏」', regulation(pad, Date.now()).includes('拿捏'));
}

console.log('\n[9] topLabel');
{
  const pad = emptyPad();
  ck('空标签返回空', topLabel(pad)[0] === '');
  pad.labels = { 开心: 0.2, 委屈: 0.5 };
  ck('取最强的那个', topLabel(pad)[0] === '委屈' && topLabel(pad)[1] === 0.5);
}

console.log('\n[10] 稳健性：坏输入不抛');
{
  ck('apply(null pad) 不抛', (() => { try { apply(null, '想你', Date.now()); return true; } catch { return false; } })());
  ck('decay(undefined) 不抛', (() => { try { decay(undefined, Date.now()); return true; } catch { return false; } })());
  ck('describe(null) 返回空', describe(null) === '');
  ck('hint(null) 返回空', hint(null) === '');
}

console.log('\n[11] 媒体占位符：不该继承旧触发原因（自检抓到的真 bug）');
{
  const now = Date.now();
  const base = { ...emptyPad(now), trigger: '怎么能说陪我洗澡是上班', labels: { 亲昵: 0.3 } };
  for (const t of ['[表情285]', '[图片]', '[表情339]', '[语音]', '[视频]']) {
    const r = apply(base, t, now + 1000);
    ck(`「${t}」清空旧 trigger`, r.trigger === '', JSON.stringify(r.trigger));
  }
  // 有文字的仍要保留
  const r2 = apply(base, '想你', now + 1000);
  ck('有文字的消息仍更新 trigger', r2.trigger === '想你', r2.trigger);
  // 占位符 + 文字：合并处理
  const r3 = apply(base, '[表情285] 想你', now + 1000);
  ck('占位符+文字仍算有内容', r3.trigger.includes('想你'), r3.trigger);
  // 关键：不能因为「表情」两字是汉字就误判
  ck('「[表情285]」不因含汉字而漏过', apply(base, '[表情285]', now).trigger === '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
