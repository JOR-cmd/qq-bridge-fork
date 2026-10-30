// 只读：会话轮换的真实收益（按全价等价 token 折算）。
//
// 为什么要折算：cacheHit 约为 cacheMiss 的 1/10 价。直接比 token 总数会把
// 「历史重发」的成本放大 10 倍，得出「省 96%」这种虚高的数字。
import fs from 'node:fs';

const rows = fs.readFileSync('state/token-usage.jsonl', 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.k === 'turn');

const main = rows.filter((r) => r.sid.includes('f52612a7'));
const recent = main.slice(-40);

// 全价等价：cacheMiss 按 1.0，cacheHit 按 0.1（DeepSeek 缓存读价约 1/10）
const HIT_RATIO = 0.1;

const sum = (arr, f) => arr.reduce((s, r) => s + (r.b[f] || 0), 0);
const miss = sum(recent, 'cacheMiss');
const hit = sum(recent, 'cacheHit');
const out = sum(recent, 'output');

const equiv = miss + hit * HIT_RATIO + out;
console.log('=== 最近 40 次调用（真实构成）===');
console.log(`cacheMiss  ${miss.toLocaleString().padStart(12)}  (全价)`);
console.log(`cacheHit   ${hit.toLocaleString().padStart(12)}  (×0.1 价)`);
console.log(`output     ${out.toLocaleString().padStart(12)}  (全价，通常×2)`);
console.log(`全价等价   ${Math.round(equiv).toLocaleString().padStart(12)}`);

// 每次调用平均
const perCall = equiv / recent.length;
const stepsPerTurn = 5.7;
console.log(`\n每次调用全价等价: ${Math.round(perCall).toLocaleString()}`);
console.log(`每回合(${stepsPerTurn} step): ${Math.round(perCall * stepsPerTurn).toLocaleString()}`);

// 轮换后的估算
// 新建会话起始上下文 ≈ 2.4 万（实测最小会话 a1aaa9b1 是 35,811；70956729 是 24,269）
// 保守取 3.5 万。轮换后 cacheMiss 会升高（缓存失效），但绝对量仍远小于 70 万
const newCtx = 35000;
const newPerCall = newCtx * 1.0; // 保守：全部按全价算（刚轮换时缓存是空的）
const newPerTurn = newPerCall * stepsPerTurn;

console.log('\n=== 轮换后的估算（保守：新会话全部按全价）===');
console.log(`每次调用 ${Math.round(newPerCall).toLocaleString()} | 每回合 ${Math.round(newPerTurn).toLocaleString()}`);
console.log(`对比现在每回合 ${Math.round(perCall * stepsPerTurn).toLocaleString()}`);
console.log(`真实节省 ≈ ${((1 - newPerTurn / (perCall * stepsPerTurn)) * 100).toFixed(0)}%`);

// 但轮换有成本：新会话要重建缓存
console.log('\n=== 轮换的代价 ===');
console.log('每次轮换：新会话第一轮全部 cacheMiss（约 3.5 万 token 全价）');
console.log('若每 30 回合轮换一次，摊薄到 30 回合 → 每回合 +1,167 全价 token');
console.log('这个代价远小于节省');
