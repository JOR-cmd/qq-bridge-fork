// 只读：查清两件事
//   ① 上下文每回合涨 ~8.8K，但「新增 miss」每次只有几百 —— 差在哪？
//   ② 为什么总输入随回合数呈**二次**增长（cap 是 step × 上下文，两者都随回合涨）
import fs from 'node:fs';

const rows = fs.readFileSync('state/token-usage.jsonl', 'utf8')
  .trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.k === 'turn');
const inOf = (r) => (r.b.cacheMiss || 0) + (r.b.cacheHit || 0);
const list = rows.filter((r) => r.sid.includes('f52612a7'));

// 按 turn 聚合
const turnMap = {};
for (const r of list) (turnMap[r.turn] ??= []).push(r);
const turns = Object.values(turnMap);
const t0 = turns[0], tN = turns[turns.length - 1];

const in0 = inOf(t0[t0.length - 1]);
const inN = inOf(tN[tN.length - 1]);
const nTurns = turns.length;
console.log('=== ① 上下文为什么涨 ===');
console.log(`第 1 回合结束上下文 ${in0} → 第 ${nTurns} 回合结束 ${inN}`);
console.log(`共涨 ${inN - in0}，平均每回合 +${Math.round((inN - in0) / (nTurns - 1))}`);
console.log();
console.log('每回合「所有 step 的 cacheMiss 之和」= 该回合真正写进上下文的新内容：');
const perTurnNew = turns.map((rs) => rs.reduce((s, r) => s + (r.b.cacheMiss || 0), 0));
const avgNew = perTurnNew.reduce((a, b) => a + b, 0) / perTurnNew.length;
console.log(`  平均每回合 +${Math.round(avgNew)} token 新内容`);
console.log(`  ≈ 每回合约 ${Math.round(avgNew)} token 被永久留在上下文里（工具调用+结果+消息，从不裁剪）`);
console.log();

console.log('=== ② 为什么是二次增长 ===');
console.log('单回合成本 = step数 × 当时的上下文大小');
console.log('而上下文 ∝ 回合数（线性累积）');
console.log('→ 第 N 回合的成本 ∝ N，总成本 ∝ N²');
console.log();
console.log('用实测验证（把回合按序号分组看平均成本）:');
const buckets = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 73]];
for (const [a, b] of buckets) {
  const rs = turns.slice(a - 1, b).flat();
  const avg = rs.reduce((s, r) => s + inOf(r), 0) / rs.length;
  const avgCtx = rs.reduce((s, r) => s + inOf(r), 0) / rs.length;
  console.log(`  回合 ${String(a).padStart(2)}-${String(b).padStart(2)}: 平均每次调用 ${String(Math.round(avg)).padStart(7)} token`);
}
console.log();

// 前后半段成本对比
const half = Math.floor(turns.length / 2);
const firstHalf = turns.slice(0, half).flat().reduce((s, r) => s + inOf(r), 0);
const secondHalf = turns.slice(half).flat().reduce((s, r) => s + inOf(r), 0);
console.log(`前 ${half} 回合总输入 ${firstHalf} | 后 ${turns.length - half} 回合总输入 ${secondHalf}`);
console.log(`后者是前者的 ${(secondHalf / firstHalf).toFixed(2)} 倍（回合数只多 ${((turns.length - half) / half).toFixed(2)} 倍）`);
console.log();

console.log('=== ③ 缓存失效的尖峰（这些是最贵的）===');
const spikes = list.filter((r) => (r.b.cacheMiss || 0) > 20000).sort((a, b) => (b.b.cacheMiss || 0) - (a.b.cacheMiss || 0));
console.log(`cacheMiss > 20000 的调用: ${spikes.length} 次`);
for (const s of spikes.slice(0, 8)) {
  console.log(`  ${new Date(s.t).toLocaleString('zh-CN', { hour12: false })} turn ${s.turn} | miss ${s.b.cacheMiss} | 上下文本应 ${inOf(s)}`);
}
