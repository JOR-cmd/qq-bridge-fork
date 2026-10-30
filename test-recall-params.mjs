// 检索参数回归（**先写测试，再改实现**）。
// 用法：node test-recall-params.mjs
//
// 锁住两个 2026-10-30 查出来的真 bug：
//   A. recallSnippets 收了 minHits 却**根本没用** —— 它自己算了个 need 传给 store.search，
//      于是 config.socialV2.recall.minHits 从来没起过作用（传 1/2/5/99 结果一字不差）。
//   B. limit 被话题扩散撑破 —— ranked 按 limit 截，但 [...ranked, ...expanded] 不占名额，
//      实测 limit=1 返回 3 条。
//
// ⚠️ 用临时库（os.tmpdir），**不碰真实 state/**。这是本项目的硬规矩。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from './src/archive-store.mjs';
import { recallSnippets, queryTokens } from './src/recall.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`); }
};

// ── 造一个可复现的小库 ────────────────────────────────────────────────
// 内容刻意对齐真实语料的结构：「洗澡」出现多次、「桥接」和「token」存在但从不共句。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-params-'));
const DB = path.join(dir, 'archive.db');
const KEY = 'private:10001';
const now = Date.now();
const DAY = 86400000;

const store = new ArchiveStore(DB);
store.addMany(KEY, [
  { t: now - 40 * DAY, side: 'him', text: '你要陪我洗澡吗' , iso: new Date(now - 40 * DAY).toISOString() },
  { t: now - 39 * DAY, side: 'him', text: '怎么能说陪我洗澡是上班，好怪哦', iso: new Date(now - 39 * DAY).toISOString() },
  { t: now - 38 * DAY, side: 'her', text: '一直在催你洗澡吹头，话就说干了', iso: new Date(now - 38 * DAY).toISOString() },
  { t: now - 37 * DAY, side: 'her', text: '洗澡去了', iso: new Date(now - 37 * DAY).toISOString() },
  { t: now - 36 * DAY, side: 'him', text: '我在改桥接的配置', iso: new Date(now - 36 * DAY).toISOString() },
  { t: now - 35 * DAY, side: 'him', text: '这个 token 又过期了', iso: new Date(now - 35 * DAY).toISOString() },
  { t: now - 34 * DAY, side: 'her', text: '作业拖到明天吧', iso: new Date(now - 34 * DAY).toISOString() },
  { t: now - 33 * DAY, side: 'him', text: '作业写完再睡', iso: new Date(now - 33 * DAY).toISOString() },
  // ★ 专门为"扩散"准备的语料：两条种子（含关键词）+ 两条同话题但**不含关键词**的其它消息。
  //   只有这样，expand() 才有东西可带 —— 否则「扩散能不能出现」这个断言是空跑的。
  //   （我第一版测试就是漏了这一条，导致"双重截断把扩散弄死"的 bug 绿着过去了。）
  { t: now - 5 * DAY,  side: 'him', text: '早点睡吧别熬了',     iso: new Date(now - 5 * DAY).toISOString() },
  { t: now - 4 * DAY,  side: 'her', text: '我睡了，你也快去睡',  iso: new Date(now - 4 * DAY).toISOString() },
  { t: now - 3 * DAY,  side: 'him', text: '晚安，做个好梦',      iso: new Date(now - 3 * DAY).toISOString() },
  { t: now - 2 * DAY,  side: 'her', text: '今天好困，先躺了',    iso: new Date(now - 2 * DAY).toISOString() },
]);
// 话题标签：让 expand() 有东西可扩散（否则 B 测不出来）
for (const id of [1, 2, 3, 4]) {
  try { store.db.exec(`UPDATE messages SET tags='洗澡' WHERE id=${id}`); } catch { /* 表结构变了就跳过 */ }
}
// 给"扩散专用"那 4 条打同一个话题标签（2 条种子 + 2 条非种子）
const seedIds = store.db.prepare("SELECT id FROM messages WHERE text LIKE '%早点睡%' OR text LIKE '%我睡了%'").all().map((r) => Number(r.id));
const otherIds = store.db.prepare("SELECT id FROM messages WHERE text LIKE '%晚安，做个好梦%' OR text LIKE '%今天好困%'").all().map((r) => Number(r.id));
for (const id of [...seedIds, ...otherIds]) {
  try { store.db.exec(`UPDATE messages SET tags='睡觉' WHERE id=${id}`); } catch { /* skip */ }
}
store.close();

const run = (opts) => recallSnippets({ dbPath: DB, key: KEY, before: now, maxChars: 60, ...opts });

// ── A. minHits 必须真的生效 ────────────────────────────────────────────
console.log('\n[A] minHits 必须影响结果（原来传什么都没用）');
{
  const q = '你陪我洗澡那次';   // 6 个词
  const r1 = run({ query: q, limit: 3, minHits: 1 });
  const r2 = run({ query: q, limit: 3, minHits: 3 });
  const r99 = run({ query: q, limit: 3, minHits: 99 });
  ck('minHits=1 有结果', r1.length > 0, `got ${r1.length}`);
  ck('minHits=99（超词数）→ 空，不抛', r99.length === 0, `got ${r99.length}`);

  // ⚠️ 语义是「下限」：minHits 只能把门槛抬高，**不能压低**。
  //   压低 = 噪声进来（实测「抱着打游戏」会捞回「是我打游戏没理你生气了吗」）。
  //   所以 minHits=1 必须与不传 minHits **完全一致**，而不是更宽松。
  const auto = run({ query: q, limit: 3 });
  ck('minHits=1 === 不传（不能压低门槛）', JSON.stringify(r1.map((h) => h.text)) === JSON.stringify(auto.map((h) => h.text)),
    `minHits=1 → ${r1.length} 条 / 默认 → ${auto.length} 条`);

  // 关键：门槛必须体现为 hitCount 的下限。
  // ⚠️ 扩散条目（fromTopic=true）不参与门槛 —— 它们是"同话题带回来的"，
  //    本来就没有关键词命中（hitCount=0 是设计如此）。所以只看种子。
  const seeds = r2.filter((h) => !h.fromTopic);
  const lowest = seeds.length ? Math.min(...seeds.map((h) => h.hitCount)) : 0;
  ck('minHits=3 时每条**种子**的 hitCount ≥ 3', seeds.length > 0 && lowest >= 3, `lowest=${lowest} seeds=${seeds.length}`);

  // 与原 bug 的直接对照：如果参数还是死的，这三种传法结果会**完全一样**
  const same = JSON.stringify(r1.map((h) => h.text)) === JSON.stringify(r99.map((h) => h.text));
  ck('minHits=1 与 minHits=99 结果确实不同（参数不是死的）', !same);
}

// ── A2. 单词查询不能被门槛夹死 ─────────────────────────────────────────
console.log('\n[A2] 单词查询：门槛超过词数时必须夹到 1，否则永不命中');
{
  const single = run({ query: '洗澡', limit: 3, minHits: 3 });
  ck('「洗澡」（1 个词）传 minHits=3 仍有结果', single.length > 0, `got ${single.length}`);
  const tooBig = run({ query: '洗澡', limit: 3, minHits: 99 });
  ck('「洗澡」传 minHits=99 仍能命中（夹到词数）', tooBig.length > 0, `got ${tooBig.length}`);
}

// ── A3. 不传 minHits 时保持原默认行为（3/4 词以上用 3，否则 2）──────────
console.log('\n[A3] 不传 minHits 时退回原有默认（别把老行为改坏）');
{
  const dLong = run({ query: '你陪我洗澡那次', limit: 3 });          // 6 词 → 默认 3
  const dShort = run({ query: '洗澡', limit: 3 });                    // 1 词 → 默认 1（夹住）
  ck('长句默认仍能命中', dLong.length > 0, `got ${dLong.length}`);
  ck('单词默认仍能命中', dShort.length > 0, `got ${dShort.length}`);
  const explicit3 = run({ query: '你陪我洗澡那次', limit: 3, minHits: 3 });
  ck('长句默认 == 显式 minHits=3', JSON.stringify(dLong.map((h) => h.text)) === JSON.stringify(explicit3.map((h) => h.text)));

  // ★ 这条是本轮最重要的回归：默认行为**不许**因为这次"修 minHits"而改变。
  //   旧实现的实际判定就是 min(3, 词数) —— 词数≥4 取 3，否则取 min(2, 词数)。
  //   下面用显式等价参数复现旧行为，逐条比对。
  const oldBehavior = (tokens) => Math.max(1, Math.min(tokens.length >= 4 ? 3 : 2, tokens.length));
  for (const query of ['你陪我洗澡那次', '洗澡', '抱着打游戏', '我不吃香菜', '桥接 token']) {
    const tk = queryTokens(query);
    if (!tk.length) continue;
    const now_ = run({ query, limit: 3 });
    const old_ = run({ query, limit: 3, minHits: oldBehavior(tk) });
    ck(`「${query}」默认行为与旧版逐条一致`, JSON.stringify(now_.map((h) => h.text)) === JSON.stringify(old_.map((h) => h.text)),
      `默认 ${now_.length} 条 / 旧 ${old_.length} 条`);
  }
}

// ── B. limit 的真实语义：管命中条数，扩散是命中之外的补充 ──────────────
//
// ⚠️ 这一节原本是错的，留档：我曾把「limit=1 返回 3 条」当成 bug B 去"修"，
//   连改三版（双重截断→扩散消失 / 名额分配→扩散压过命中 / 加约束→又变 0 扩散），
//   每版都真的弄坏了东西。最后核对源码注释才明白：
//   **limit 限制的是关键词命中数，扩散本来就不占它的名额**（"扩散是补充，不该喧宾夺主"）。
//   所以这一节改成**锁住原设计**，而不是锁住我臆想出来的契约。
console.log('\n[B] limit 管命中条数；扩散是命中之外的补充（原设计，别再「修」它）');
{
  // ① 命中条数受 limit 约束
  for (const lim of [1, 2, 3]) {
    const r = run({ query: '洗澡 吹头', limit: lim, minHits: 2 });
    const seeds = r.filter((h) => !h.fromTopic).length;
    ck(`limit=${lim} 时命中条数 ≤ ${lim}`, seeds <= lim, `seeds=${seeds}`);
  }

  // ② 总数可以是 limit + 扩散条数（这是设计，不是违约）
  const r3 = run({ query: '睡', limit: 3, minHits: 1 });
  ck('limit=3 时总数允许超过 3（扩散是额外补充）', r3.length >= 1 && r3.length <= 3 + 2,
    `got ${r3.length}（上限应为 3 命中 + 2 扩散 = 5）`);

  // ③ 扩散永远排在命中之后（这是"不喧宾夺主"的机制保证）
  let orderOk = true;
  for (const q of ['睡', '洗澡', '游戏', '眼睛']) {
    const r = run({ query: q, limit: 3, minHits: 1 });
    const firstTopic = r.findIndex((h) => h.fromTopic);
    if (firstTopic > 0) {
      const lastSeed = r.map((h) => h.fromTopic).lastIndexOf(false);
      if (lastSeed > firstTopic) orderOk = false;   // 扩散插到命中前面了 → 违约
    }
  }
  ck('扩散不会插到命中前面（顺序保证"不喧宾夺主"）', orderOk);

  // ④ 扩散确实存在（防止再被"优化"掉）
  const hasTopic = ['睡', '洗澡', '游戏', '眼睛', '作业'].some((q) => {
    const r = run({ query: q, limit: 3, minHits: 1 });
    return r.some((h) => h.fromTopic);
  });
  ck('扩散功能仍然存在（不是被静默关掉）', hasTopic);
}

// ── C. 稳健性 ──────────────────────────────────────────────────────────
console.log('\n[C] 边界与稳健性');
{
  ck('limit=0 不抛', (() => { try { run({ query: '洗澡', limit: 0 }); return true; } catch { return false; } })());
  ck('limit=NaN 退回默认', (() => { try { const r = run({ query: '洗澡', limit: Number.NaN }); return r.length > 0; } catch { return false; } })());
  ck('minHits=NaN 退回默认', (() => { try { const r = run({ query: '洗澡', minHits: Number.NaN }); return r.length > 0; } catch { return false; } })());
  ck('minHits=负数 不抛', (() => { try { run({ query: '洗澡', minHits: -5 }); return true; } catch { return false; } })());
  ck('空查询 → 空数组', run({ query: '   ' }).length === 0);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
