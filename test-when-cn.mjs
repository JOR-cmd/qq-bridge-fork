// L1 回归：中文时间说法解析（不联网、不碰真实 state/）。
// 用法：node test-when-cn.mjs
//
// 重点覆盖两类坑：
//   ① **本地日历 vs UTC**：原版（dsh-silicon/when.ts）用 UTC 算日期，
//      在 +08:00 时区下凌晨时段会差一天。这里改成全部走本地日历。
//   ② **匹配顺序**：「2026-08-03」不能被「8月3号」抢走；「前天」不能被「昨天」抢走。
import { parseWhen, cn2int, addDays, weekday, dayOf } from './src/when-cn.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${detail}`); } };

const NOW = '2026-10-29'; // 星期四

console.log('\n[1] 绝对日期');
ck('YYYY-MM-DD', JSON.stringify(parseWhen('2026-08-03 那天', NOW)) === '["2026-08-03","2026-08-03"]', JSON.stringify(parseWhen('2026-08-03 那天', NOW)));
ck('非法日期 2月30日 不被采纳（回退到别的说法或 null）', parseWhen('2026-02-30 那天', NOW) === null, JSON.stringify(parseWhen('2026-02-30 那天', NOW)));
ck('X月Y号（当年）', JSON.stringify(parseWhen('8月3号', NOW)) === '["2026-08-03","2026-08-03"]', JSON.stringify(parseWhen('8月3号', NOW)));
ck('X月Y日', JSON.stringify(parseWhen('十月一号', NOW)) === '["2026-10-01","2026-10-01"]', JSON.stringify(parseWhen('十月一号', NOW)));

console.log('\n[2] 相对日');
ck('昨天', JSON.stringify(parseWhen('昨天说的', NOW)) === '["2026-10-28","2026-10-28"]', JSON.stringify(parseWhen('昨天说的', NOW)));
ck('前天', JSON.stringify(parseWhen('前天', NOW)) === '["2026-10-27","2026-10-27"]', JSON.stringify(parseWhen('前天', NOW)));
ck('大前天', JSON.stringify(parseWhen('大前天', NOW)) === '["2026-10-26","2026-10-26"]', JSON.stringify(parseWhen('大前天', NOW)));
ck('3天前', JSON.stringify(parseWhen('3天前', NOW)) === '["2026-10-26","2026-10-26"]', JSON.stringify(parseWhen('3天前', NOW)));
ck('三天前（中文数字）', JSON.stringify(parseWhen('三天前', NOW)) === '["2026-10-26","2026-10-26"]', JSON.stringify(parseWhen('三天前', NOW)));
ck('「前天」不被「昨天」抢走（顺序正确）', JSON.stringify(parseWhen('前天晚上', NOW)) === '["2026-10-27","2026-10-27"]', JSON.stringify(parseWhen('前天晚上', NOW)));

console.log('\n[3] 周');
ck('上周 = 整周区间', JSON.stringify(parseWhen('上周', NOW)) === '["2026-10-19","2026-10-25"]', JSON.stringify(parseWhen('上周', NOW)));
ck('上周三', JSON.stringify(parseWhen('上周三', NOW)) === '["2026-10-21","2026-10-21"]', JSON.stringify(parseWhen('上周三', NOW)));
ck('上上个礼拜', JSON.stringify(parseWhen('上上个礼拜', NOW)) === '["2026-10-12","2026-10-18"]', JSON.stringify(parseWhen('上上个礼拜', NOW)));

console.log('\n[4] 月');
ck('本月 = 整月', JSON.stringify(parseWhen('这个月', NOW)) === '["2026-10-01","2026-10-31"]', JSON.stringify(parseWhen('这个月', NOW)));
ck('本月下旬', JSON.stringify(parseWhen('本月下旬', NOW)) === '["2026-10-21","2026-10-31"]', JSON.stringify(parseWhen('本月下旬', NOW)));
ck('上月 = 整月（9 月 30 天）', JSON.stringify(parseWhen('上个月', NOW)) === '["2026-09-01","2026-09-30"]', JSON.stringify(parseWhen('上个月', NOW)));

console.log('\n[5] 本地日历 vs UTC（关键坑）');
{
  // 在 +08:00 时区，2026-10-29 00:30 本地 = 2026-10-28 16:30 UTC
  // 若按 UTC 算「昨天」会得到 10-27，按本地算应得 10-28
  const ms = new Date(2026, 9, 29, 0, 30).getTime(); // 本地 2026-10-29 00:30
  const localDay = dayOf(ms);
  ck('凌晨时刻按本地日历算日期', localDay === '2026-10-29', localDay);
  ck('凌晨的「昨天」= 本地前一天', JSON.stringify(parseWhen('昨天', localDay)) === '["2026-10-28","2026-10-28"]', JSON.stringify(parseWhen('昨天', localDay)));
}

console.log('\n[6] 边界与稳健');
ck('空串 → null', parseWhen('', NOW) === null);
ck('无时间说法 → null', parseWhen('今天吃什么', NOW) === null, JSON.stringify(parseWhen('今天吃什么', NOW)));
ck('null 输入 → null（不抛）', parseWhen(null, NOW) === null);
ck('cn2int 十八 = 18', cn2int('十八') === 18, String(cn2int('十八')));
ck('cn2int 二十 = 20', cn2int('二十') === 20, String(cn2int('二十')));
ck('cn2int 十 = 10', cn2int('十') === 10, String(cn2int('十')));
ck('addDays 跨月', addDays('2026-10-31', 1) === '2026-11-01', addDays('2026-10-31', 1));
ck('addDays 跨年', addDays('2026-12-31', 1) === '2027-01-01', addDays('2026-12-31', 1));
ck('addDays 负跨月', addDays('2026-11-01', -1) === '2026-10-31', addDays('2026-11-01', -1));
ck('weekday 星期四 = 3', weekday('2026-10-29') === 3, String(weekday('2026-10-29')));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
