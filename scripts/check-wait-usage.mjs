// 只读：真实等待时长（最终版）。
//
// 配对规则的演进（每次都算错过，记下来）：
//   ① 按 sessionId 分桶排队 → 跨会话交错时错位，算出「等待 313h > 跨度 123h」，物理不成立。
//   ② 严格一次性配对 → 仍只有 69/352 配上：因为有 call 丢了 result（日志里 06:46:52 那次后面
//      直接跟了下一个 call），队列据此错一位，后面全歪。
//   ③ 本版：**每个 result 配它前面最近的、同会话同工具、且时间差不超过其 timeout 的 call**。
//      丢了 result 的 call 会被自然跳过，不会错位。
import fs from 'node:fs';

const rows = fs.readFileSync('state/tool-calls.jsonl', 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .map((r) => ({ ...r, at: new Date(r.time).getTime() }))
  .sort((a, b) => a.at - b.at);

const calls = new Map(); // key -> 未消化的 call 列表（按时间）
const pairs = [];
const usedCall = new Set();

for (const r of rows) {
  const k = `${r.sessionId}|${r.tool}`;
  if (r.type === 'call') {
    const q = calls.get(k) ?? [];
    q.push(r);
    calls.set(k, q);
  } else if (r.type === 'result') {
    const q = calls.get(k);
    if (!q || !q.length) continue;
    // 从最近的一个往后找：时间差必须 <= 它的 timeout + 余量，且未被用过
    for (let i = q.length - 1; i >= 0; i -= 1) {
      const c = q[i];
      if (usedCall.has(c.time + c.tool)) continue;
      let lim = 30000;
      try { lim = JSON.parse(c.args).timeoutMs ?? 30000; } catch {}
      const dt = r.at - c.at;
      if (dt >= 0 && dt <= lim + 20000) {
        usedCall.add(c.time + c.tool);
        q.splice(i, 1);
        pairs.push({ call: c, dtMs: dt, lim });
        break;
      }
      // 时间差已超过上限，说明这个 call 没有对应 result，跳过它继续往前
      if (dt > lim + 20000) break;
    }
  }
}

const waits = pairs.filter((p) => /qq_wait_for_messages/.test(p.call.tool));
console.log(`等待配对: ${waits.length} / 358`);
const dt = waits.map((w) => w.dtMs).sort((a, b) => a - b);
const q = (f) => (dt[Math.floor(dt.length * f)] / 1000).toFixed(1);
console.log('\n=== 真实等待时长 ===');
console.log(`中位 ${q(0.5)}s | 平均 ${(dt.reduce((a, b) => a + b, 0) / dt.length / 1000).toFixed(0)}s | p25 ${q(0.25)}s | p75 ${q(0.75)}s | p90 ${q(0.9)}s | 最大 ${(dt[dt.length - 1] / 1000).toFixed(0)}s`);

console.log('\n=== 请求上限 vs 实际消耗（核心问题：等这么久值不值）===');
console.log('上限   次数   中位      均值     跑满%  提前返回%   总耗时');
const byLim = {};
for (const w of waits) (byLim[w.lim] ??= []).push(w.dtMs);
for (const [lim, xs] of Object.entries(byLim).sort((a, b) => b[1].length - a[1].length)) {
  const ss = xs.slice().sort((a, b) => a - b);
  const med = ss[Math.floor(ss.length / 2)] / 1000;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length / 1000;
  const full = xs.filter((x) => x >= +lim * 0.95).length;
  const tot = (xs.reduce((a, b) => a + b, 0) / 3600000).toFixed(2);
  console.log(`${(lim / 1000).toFixed(0).padStart(4)}s ${String(xs.length).padStart(5)} ${med.toFixed(0).padStart(8)}s ${avg.toFixed(0).padStart(8)}s ${(full / xs.length * 100).toFixed(0).padStart(6)}% ${((1 - full / xs.length) * 100).toFixed(0).padStart(9)}% ${tot.padStart(7)}h`);
}

const total = dt.reduce((a, b) => a + b, 0);
const span = rows[rows.length - 1].at - rows[0].at;
console.log(`\n合计等待 ${(total / 3600000).toFixed(2)}h | 日志跨度 ${(span / 3600000).toFixed(1)}h | 占比 ${(total / span * 100).toFixed(2)}%`);
