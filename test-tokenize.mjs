// 分词回归测试（**先写测试，再改实现**）。
// 用法：node test-tokenize.mjs
//
// 要锁住的行为：一句话里的中文词不能被"切碎"。
// 现在的 bug（recall.mjs:16 的 `i += 2`）：长句按 2 字块**跳步**切，
// 「你陪我洗澡那次」被切成 ["你陪","我洗","澡那"] —— "洗澡"这个真实存在的词
// 根本没进检索词，所以永远查不到（实测「洗澡」在库里出现 9 次却 0 命中）。
//
// 修法：改成滑动 2-gram（步长 1），保住所有相邻二字组合。
//
// ⚠️ 这个测试在修复前**必须失败**，修复后才通过 —— 否则等于没测到东西。
import { queryTokens } from './src/recall.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`); }
};

console.log('\n[1] 核心 bug：长句里的二字词不能被切碎');
{
  // 「你陪我洗澡那次」必须能切出「洗澡」
  const t1 = queryTokens('你陪我洗澡那次');
  ck('「你陪我洗澡那次」含「洗澡」', t1.includes('洗澡'), JSON.stringify(t1));

  // 「抱着打游戏」必须能切出「游戏」
  const t2 = queryTokens('抱着打游戏');
  ck('「抱着打游戏」含「游戏」', t2.includes('游戏'), JSON.stringify(t2));

  // 「上次打游戏打到第几把」必须能切出「游戏」
  const t3 = queryTokens('上次打游戏打到第几把');
  ck('「上次打游戏打到第几把」含「游戏」', t3.includes('游戏'), JSON.stringify(t3));

  // 「你催我去洗澡」必须能切出「洗澡」
  const t4 = queryTokens('你催我去洗澡');
  ck('「你催我去洗澡」含「洗澡」', t4.includes('洗澡'), JSON.stringify(t4));
}

console.log('\n[2] 短句保持整体（不能被拆）');
{
  const short = queryTokens('洗澡');
  ck('「洗澡」整体保留', short.length === 1 && short[0] === '洗澡', JSON.stringify(short));

  const s4 = queryTokens('想你了');
  ck('4 字短句整体保留', s4.length === 1 && s4[0] === '想你了', JSON.stringify(s4));

  // 边界：正好 4 字和 5 字
  const four = queryTokens('ABCD');  // 非中文，走英文规则
  const five = queryTokens('一二三四五');
  ck('5 字句会切分（不再是整体）', five.length > 1, JSON.stringify(five));
}

console.log('\n[3] 英文与中英混合');
{
  const en = queryTokens('bridge token');
  ck('英文按词切', en.includes('bridge') && en.includes('token'), JSON.stringify(en));

  const mix = queryTokens('桥接 token');
  ck('中英混合：中文部分和英文都保留', mix.includes('token') && mix.some((x) => /[\u4e00-\u9fff]/.test(x)), JSON.stringify(mix));
}

console.log('\n[4] 数量上限（防止一次查询塞太多词）');
{
  const long = queryTokens('这是一段很长很长很长的中文句子用来测试数量上限是否生效');
  ck('不超过 12 个词', long.length <= 12, `got ${long.length}`);
}

console.log('\n[5] 稳健性');
{
  ck('空串 → 空数组', queryTokens('').length === 0);
  ck('null → 空数组（不抛）', queryTokens(null).length === 0);
  ck('纯标点 → 空数组', queryTokens('，，。！？').length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
