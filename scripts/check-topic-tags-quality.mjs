// 代码质量自检：简化设计（话题标签）的边界与健壮性。
// 只读，不碰真实 state/。
import { TOPIC_RULES, extractTags, mergeTags, tagOverlap, serializeTags, parseTags } from '../src/topic-tags.mjs';

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log('\n[1] 极端输入：不能抛、不能卡');
{
  const huge = '洗澡'.repeat(5000);
  const t0 = Date.now();
  const tags = extractTags(huge);
  const ms = Date.now() - t0;
  ck('5000 字长文本不抛', true);
  ck('耗时 < 100ms（正则不能回溯爆炸）', ms < 100, `${ms}ms`);
  ck('重复词只出 1 个标签', tags.length <= 1, JSON.stringify(tags));

  ck('含控制字符不抛', (() => { try { extractTags('\n\t\u0000 洗澡'); return true; } catch { return false; } })());
  ck('超长单字串不抛', (() => { try { extractTags('洗'.repeat(10000)); return true; } catch { return false; } })());
  // 关键：重叠正则的最坏情况（多个规则都能匹配同一串）
  const worst = '洗澡游戏作业吃饭睡觉表情包B站眼睛契阔'.repeat(500);
  const t1 = Date.now();
  extractTags(worst);
  ck('全话题命中时耗时 < 200ms', Date.now() - t1 < 200, `${Date.now() - t1}ms`);
}

console.log('\n[2] 序列化往返：入库 → 读出必须一致');
{
  const cases = [
    ['单标签', ['洗澡']],
    ['多标签', ['洗澡', '游戏']],
    ['空', []],
  ];
  for (const [name, tags] of cases) {
    const s = serializeTags(tags);
    const back = parseTags(s);
    ck(`${name} 往返一致`, JSON.stringify(back) === JSON.stringify(tags), `"${s}" → ${JSON.stringify(back)}`);
  }
  ck('空串解析成空数组', parseTags('').length === 0);
  ck('带空格能解析', JSON.stringify(parseTags('洗澡, 游戏')) === '["洗澡","游戏"]', JSON.stringify(parseTags('洗澡, 游戏')));
  ck('多余逗号不产生空项', parseTags('洗澡,,游戏').length === 2, JSON.stringify(parseTags('洗澡,,游戏')));
}

console.log('\n[3] 标签名不能污染 SQL LIKE 查询');
{
  // 标签会拼进 LIKE '%洗澡%'。如果话题名里有 % 或 _，会让 LIKE 行为异常。
  const bad = TOPIC_RULES.filter(([n]) => /[%_\\]/.test(n));
  ck('话题名不含 SQL 通配符 % / _', bad.length === 0, JSON.stringify(bad.map(([n]) => n)));
  ck('话题名不含单引号', TOPIC_RULES.every(([n]) => !n.includes("'")));
}

console.log('\n[4] 规则质量：不能误伤（抽查真实语料里的易混词）');
{
  const negatives = [
    ['觉得', '睡觉'],
    ['打开', '游戏'],
    ['表情严肃', '表情包'],   // 这个会命中「表情」—— 接受，因为确实在聊表情
    ['吃饱了', '吃饭'],       // 会命中 —— 接受
  ];
  ck('「觉得」不触发睡觉', !extractTags('我觉得还行').includes('睡觉'), JSON.stringify(extractTags('我觉得还行')));
  ck('「打开」不触发游戏', !extractTags('打开看看').includes('游戏'), JSON.stringify(extractTags('打开看看')));
  ck('「打电话」不触发游戏', !extractTags('我给他打电话').includes('游戏'), JSON.stringify(extractTags('我给他打电话')));
}

console.log('\n[5] overlap 的数学正确性');
{
  ck('自身重叠 = 1', tagOverlap(['a', 'b'], ['a', 'b']) === 1);
  ck('互斥 = 0', tagOverlap(['a'], ['b']) === 0);
  ck('空 = 0', tagOverlap([], []) === 0);
  // 对称性
  ck('对称', Math.abs(tagOverlap(['a', 'b'], ['b']) - tagOverlap(['b'], ['a', 'b'])) < 1e-9);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
