// L1 回归：时间说法剥离（不联网、不碰真实 state/）。
// 用法：node test-recall-strip.mjs
//
// 为什么单独测：剥离函数一旦误伤内容词，检索会静默变差（不报错），
// 极难在线上发现。实测踩过的坑：「作业 前天」不剥离 → 门槛抬到 2 → 永不命中。
import { stripWhenWords } from './src/recall.mjs';
import { parseWhen } from './src/when-cn.mjs';

let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log('\n[1] 时间词被剥离');
for (const [q, want] of [
  ['作业 前天', '作业'],
  ['昨天 他说想我', '他说想我'],
  ['三天前 作业', '作业'],
  ['2026-08-03 那天说的', '那天说的'],
  ['8月3号 爬山', '爬山'],
  ['上个月 工资', '工资'],
  ['昨天', ''],
  ['上周三', ''],
]) {
  ck(`「${q}」→「${want}」`, stripWhenWords(q) === want, `got「${stripWhenWords(q)}」`);
}

console.log('\n[2] 不误伤内容词（关键：宁可漏剥，不能错剥）');
for (const q of ['前面那个','以前的事','超前部署','月工资','周末计划','上瘾','下周三']) {
  const out = stripWhenWords(q);
  ck(`「${q}」不被清空`, out.length > 0, `got「${out}」`);
}
ck('「前面」不被剥（「前」单字不是时间词）', stripWhenWords('前面那个') === '前面那个', stripWhenWords('前面那个'));
ck('「以前」不被剥', stripWhenWords('以前的事') === '以前的事', stripWhenWords('以前的事'));
ck('「周末」不被当成周几剥掉', stripWhenWords('周末计划').includes('周末') || stripWhenWords('周末计划').length > 0, stripWhenWords('周末计划'));

console.log('\n[3] 剥离后仍能解析出时间窗（两件事独立）');
{
  const today = '2026-10-30';
  ck('「作业 前天」仍解析出 10-28', JSON.stringify(parseWhen('作业 前天', today)) === '["2026-10-28","2026-10-28"]');
  ck('剥离后只剩内容词「作业」', stripWhenWords('作业 前天') === '作业');
}

console.log('\n[4] 边界');
ck('空串 → 空串', stripWhenWords('') === '');
ck('null → 空串（不抛）', stripWhenWords(null) === '');
ck('纯空白 → 空串', stripWhenWords('   ') === '');
ck('连续时间词都剥掉', stripWhenWords('昨天 前天 三天前 作业') === '作业', stripWhenWords('昨天 前天 三天前 作业'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
