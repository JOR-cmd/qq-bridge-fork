// 只读自检：信邀请「送达才记」的逻辑（不启桥、不联网、不碰真实 state/）。
// 把 bridge.js 里那段 Promise.all 逻辑原样复刻成纯函数，逐分支验证。
let pass = 0; let fail = 0;
const ck = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

// 复刻：与 src/bridge.js 定时器里那段保持同构
async function runInvite({ keys, send, lastSentDay, day, blockedUntil = 0, now = 1_000_000 }) {
  const log = [];
  const COOLDOWN = 10 * 60 * 1000;
  let last = lastSentDay;
  let blocked = blockedUntil;
  // 冷却检查（bridge 里在 shouldInviteCovenant 之后）
  if (blocked && now < blocked) return { last, blocked, skipped: 'cooldown', log };
  const tasks = keys.map((key) => Promise.resolve(send(key))
    .then((r) => ({ key, ok: !(r && r.ok === false && r.queued !== true) }))
    .catch(() => ({ key, ok: false })));
  if (!tasks.length) return { last: day, blocked, log };
  const results = await Promise.all(tasks);
  const failed = results.filter((r) => !r.ok);
  if (failed.length && failed.length === results.length) {
    blocked = now + COOLDOWN;
    log.push('all-failed');
    return { last, blocked, log };
  }
  blocked = 0;
  last = day;
  log.push(failed.length ? 'partial' : 'all-sent');
  return { last, blocked, log, failed: failed.map((r) => r.key) };
}

const KEYS = ['private:1'];

console.log('\n[1] 全部送达 → 记今天');
{
  const r = await runInvite({ keys: KEYS, send: async () => ({ ok: true }), lastSentDay: '', day: '2026-10-29' });
  ck('记录邀请日', r.last === '2026-10-29', r.last);
  ck('没有冷却', r.blocked === 0, String(r.blocked));
}

console.log('\n[2] 全部失败 → **不**记今天，并设冷却（关键：不能每分钟重试 60 次）');
{
  const r = await runInvite({ keys: KEYS, send: async () => ({ ok: false, error: '被拒' }), lastSentDay: '', day: '2026-10-29', now: 1_000_000 });
  ck('不记录邀请日（留给重试）', r.last === '', JSON.stringify(r.last));
  ck('设置了冷却', r.blocked === 1_000_000 + 600_000, String(r.blocked));
}

console.log('\n[3] 冷却期内再跳一次 → 直接跳过，不再投递');
{
  const r = await runInvite({ keys: KEYS, send: async () => ({ ok: true }), lastSentDay: '', day: '2026-10-29', now: 1_000_000 + 60_000, blockedUntil: 1_000_000 + 600_000 });
  ck('被冷却拦住', r.skipped === 'cooldown', String(r.skipped));
  ck('没记录邀请日', r.last === '');
}

console.log('\n[4] 冷却过期后重试成功 → 记今天、清冷却');
{
  const r = await runInvite({ keys: KEYS, send: async () => ({ ok: true }), lastSentDay: '', day: '2026-10-29', now: 1_000_000 + 601_000, blockedUntil: 1_000_000 + 600_000 });
  ck('记录邀请日', r.last === '2026-10-29');
  ck('冷却已清', r.blocked === 0);
}

console.log('\n[5] queued（DSH 不可用但已入队）视为已送达 → 不重复轰炸');
{
  const r = await runInvite({ keys: KEYS, send: async () => ({ ok: false, queued: true, error: '排队' }), lastSentDay: '', day: '2026-10-29' });
  ck('queued 记为已送达（DSH 会补投）', r.last === '2026-10-29', r.last);
  ck('queued 不触发冷却', r.blocked === 0, String(r.blocked));
}

console.log('\n[6] 会话繁忙（返回 undefined）→ 视为已送达，不重试');
{
  const r = await runInvite({ keys: KEYS, send: async () => undefined, lastSentDay: '', day: '2026-10-29' });
  ck('undefined 记为成功', r.last === '2026-10-29', r.last);
}

console.log('\n[7] 多会话部分失败 → 记今天（至少送出去一条）');
{
  const r = await runInvite({
    keys: ['a', 'b', 'c'],
    send: async (k) => (k === 'b' ? { ok: false, error: '拒' } : { ok: true }),
    lastSentDay: '', day: '2026-10-29',
  });
  ck('记了今天', r.last === '2026-10-29');
  ck('列出失败的会话', JSON.stringify(r.failed) === '["b"]', JSON.stringify(r.failed));
  ck('没有冷却（部分成功不该冷却）', r.blocked === 0);
}

console.log('\n[8] 抛异常 → 记为失败');
{
  const r = await runInvite({ keys: KEYS, send: async () => { throw new Error('boom'); }, lastSentDay: '', day: '2026-10-29' });
  ck('异常也走失败路径（不记今天）', r.last === '', r.last);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
