// 只读：分条规则改前/改后对比。
//
// 权威口径 = qq-activity.log 里的「工具统一发送：成功 N/N 条」——
// 这是「一次调用真的发了几条」，不用按时间戳猜回合。
//
// 日志跨零点且按大小轮转，所以日期靠「时:分:秒 回绕检测」推断：
//   · qq-activity.log.1 : 10-27 13:26:58 → 10-28 00:37:52（全部在 23:53 之前）
//   · qq-activity.log   : 10-28 00:37:57 → 10-29 02:42:04（含 10-29 凌晨，即改后）
//
// 改前基线取 .1（185 次），改后取 log 里 10-28 23:53 之后的记录。
import fs from 'node:fs';

const CUT_H = 23, CUT_M = 53; // 2026-10-28 23:53 预设改写时刻

const RE = /^\[(\d{2}):(\d{2}):(\d{2})\].*?成功 (\d+)\/(\d+) 条/;

function readCalls(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(RE);
    if (!m) continue;
    const h = +m[1], mi = +m[2], s = +m[3];
    out.push({ h, mi, s, hms: h * 3600 + mi * 60 + s, n: +m[4], ok: m[4] === m[5] });
  }
  return out;
}

// log 文件里第一条「时间回绕」（hms 变小）= 跨过 10-28 → 10-29 的午夜
const logCalls = readCalls('state/qq-activity.log');
let wrapAt = -1;
for (let i = 1; i < logCalls.length; i += 1) {
  if (logCalls[i].hms < logCalls[i - 1].hms) { wrapAt = i; break; }
}

const after = logCalls.filter((c, i) => {
  const isNextDay = wrapAt >= 0 && i >= wrapAt;           // 10-29 凌晨 → 一定在改动之后
  const sameDayLate = !isNextDay && (c.h > CUT_H || (c.h === CUT_H && c.mi >= CUT_M));
  return isNextDay || sameDayLate;
});

const before = readCalls('state/qq-activity.log.1');       // 10-27 13:26 → 10-28 00:37

const dist = (xs) => {
  if (!xs.length) return '（无数据）';
  const d = {};
  for (const n of xs) d[n] = (d[n] || 0) + 1;
  return Object.keys(d).sort((a, b) => +a - +b)
    .map((k) => `${k}条 ${String(d[k]).padStart(3)}(${(d[k] / xs.length * 100).toFixed(0).padStart(3)}%)`)
    .join('  ');
};
const pct = (xs, f) => (xs.length ? (xs.filter(f).length / xs.length * 100).toFixed(0) + '%' : 'n/a');
const avg = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : 'n/a');

console.log('口径：一次「工具统一发送」调用真的发了几条（日志权威记录）\n');
console.log(`改前基线  ${String(before.length).padStart(3)} 次 | ${dist(before.map(c => c.n))}`);
console.log(`          平均 ${avg(before.map(c => c.n))} 条 | 恰好 2 条 ${pct(before, c => c.n === 2)} | ≥3 条 ${pct(before, c => c.n >= 3)}`);
console.log();
console.log(`改后      ${String(after.length).padStart(3)} 次 | ${dist(after.map(c => c.n))}`);
console.log(`          平均 ${avg(after.map(c => c.n))} 条 | 恰好 2 条 ${pct(after, c => c.n === 2)} | ≥3 条 ${pct(after, c => c.n >= 3)}`);
if (wrapAt >= 0) {
  console.log(`\n（log 文件在索引 ${wrapAt} 处跨零点：${String(logCalls[wrapAt - 1].h).padStart(2,'0')}:${String(logCalls[wrapAt-1].mi).padStart(2,'0')} → ${String(logCalls[wrapAt].h).padStart(2,'0')}:${String(logCalls[wrapAt].mi).padStart(2,'0')}）`);
} else {
  console.log('\n⚠ 未检测到跨零点，改后统计可能不准');
}
console.log('\n⚠ 样本提醒：改后样本量小，且集中在「改规则」这场高情绪对话里，别当成稳定分布。');
