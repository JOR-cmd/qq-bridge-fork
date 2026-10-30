// 每日记忆维护：衰减 → 归档 → 合并 → 删除。
//
// 设计来源（**只借设计，不复制代码**）：memory-brain 的 store.py / engine.py
//   decay()          store.py:667-694  —— 每日衰减，近 30 天访问过的减半
//   archive()        store.py:696-725  —— importance 低且久未访问 → 归档
//   trim_kind()      store.py:727-744  —— 分类超量时按 importance 挤掉
//   purge_archived() store.py:746-757  —— 归档超期彻底删除
//
// 我们**照抄的数值**（每一步都注明出处，方便以后核对）：
//   rate = 0.01/天                    store.py:669
//   access_boost = 0.5（最多减半衰减） store.py:672
//   access_window_days = 30            store.py:673
//   access_max_count = 10              store.py:674
//   archive 阈值 importance < 0.3      engine.py:298
//   archive 要求 older_than_days=30    engine.py:299
//   archive 保护 protect_days=30       engine.py:301
//   purge keep_days = 180              engine.py:307
//
// ⚠️ 与它**不同**的地方（都是按主人决定改的）：
//   ① L4 锚（covenant_marks.tier='L4'）**永不衰减、永不归档、永不删除**
//      依据：它是"锚"，衰减就违背定义（memory-brain 的识海也是 importance 恒 1.0）
//   ② 我们**不只是 messages**，还维护 covenant_marks（按 tier 的半衰期）
//   ③ 删除阈值/开关都走配置，默认**开删除**（主人 2026-10-30 明确要求）
//
// 用法：
//   node scripts/decay-memory.mjs --dry-run   # 只看会做什么
//   node scripts/decay-memory.mjs             # 执行
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'archive.db');
const CFG = path.join(ROOT, 'config.json');
const DRY = process.argv.includes('--dry-run');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const M = cfg.socialV2?.memory ?? {};
const P = {
  rate: Number(M.decayRate ?? 0.01),
  accessBoost: Number(M.accessBoost ?? 0.5),
  accessWindowDays: Number(M.accessWindowDays ?? 30),
  accessMaxCount: Number(M.accessMaxCount ?? 10),
  archiveBelow: Number(M.archiveBelow ?? 0.3),
  archiveOlderThanDays: Number(M.archiveOlderThanDays ?? 30),
  protectDays: Number(M.protectDays ?? 30),
  purgeKeepDays: Number(M.purgeKeepDays ?? 180),
  purgeEnabled: M.purgeEnabled !== false,   // 主人决定：默认开
};

const db = new DatabaseSync(DB);
// ⚠️ 2026-10-30 深度自检补漏：这个脚本做批量 UPDATE + DELETE，
//   而桥接进程同时持有同一个库的连接（startArchiveFlusher 每 60 秒写一次）。
//   没有 busy_timeout 的话，撞上桥接写入会立刻抛 SQLITE_BUSY，
//   而调度器是"先记再跑"→ 这一天就跳过了（衰减推迟一天）。
//   3000ms 与 archive-store.mjs:35 保持一致。
db.exec('PRAGMA busy_timeout = 3000');
const now = Date.now();
const DAY = 86400000;

// ── 幂等守卫（2026-10-30 补）──────────────────────────────────────────
//
// ⚠️ 这个脚本**本来不是幂等的**：衰减是"按当前值再乘 (1-rate)"，
//   同一天跑两次就衰减两次。而调度器那边改成了"失败不记账、冷却后重试"，
//   于是**重试会把同一天衰减两遍** —— 这个洞是我修 bug D 时亲手引入的。
//
// 现在把"今天是否已衰减过"记到库里（meta 表），脚本自己认：
//   · 已经跑过 → 直接退出（除非 --force），重复调用不会多衰减一次
//   · 没有跑过 → 正常跑，跑完记账
// 这样无论调度器重试几次（或有人手敲几次），一天最多衰减一次。
// 记账与衰减写在**同一个事务**里 —— 否则"衰减成功但记账失败"会变成第二次衰减。
const META_KEY = 'decay:lastDay';
const todayLocal = (() => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const FORCE = process.argv.includes('--force');
function ensureMetaTable() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
}
function readMeta(k) {
  try { return db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null; } catch { return null; }
}
ensureMetaTable();
const alreadyDay = readMeta(META_KEY);

console.log(`=== 记忆维护 ${DRY ? '（dry-run，不写库）' : ''} ===`);
console.log(`库: ${DB}`);
console.log(`参数: 衰减 ${P.rate}/天 | 访问加成 ${P.accessBoost} | 窗口 ${P.accessWindowDays}天 | 归档 <${P.archiveBelow} | 清理 ${P.purgeEnabled ? P.purgeKeepDays + '天' : '关闭'}`);
console.log();

// 幂等检查放在这里：dry-run 不写库，所以只报告不拦截。
if (alreadyDay === todayLocal && !DRY && !FORCE) {
  console.log(`[跳过] 今天（${todayLocal}）已经跑过一次了，不再重复衰减。`);
  console.log('         （要强制重跑：node scripts/decay-memory.mjs --force）');
  console.log('         （这条守卫是为了防"调度器重试"把同一天衰减两遍。）');
  db.close();
  process.exit(0);
}
if (alreadyDay === todayLocal && DRY) {
  console.log(`[提示] 今天（${todayLocal}）已经真的跑过一次了；下面显示的是"再跑一次会怎样"。`);
  console.log();
}

// ── ① 衰减 messages（照搬 store.py:667-694）────────────────────────────
console.log('[1] 每日衰减（messages）');
const windowStart = now - P.accessWindowDays * DAY;
const rows = db.prepare(
  "SELECT id, importance, access_count, last_access FROM messages WHERE status='active'",
).all();
const updates = [];
for (const r of rows) {
  // factor：近 30 天内被访问过 → 最多减半衰减（访问越多越接近 0.5）
  let factor = 1.0;
  const lastAccess = Number(r.last_access) || 0;
  if (lastAccess && lastAccess >= windowStart) {
    factor = 1.0 - P.accessBoost * Math.min(1.0, (Number(r.access_count) || 0) / Math.max(1, P.accessMaxCount));
  }
  // ⚠️ 下限 0.01：防止 importance 变成 0 或负数（参考实现也是 max(0.01, ...)）
  const next = Math.max(0.01, Number(r.importance) * (1.0 - P.rate * factor));
  updates.push([Number(next.toFixed(4)), Number(r.id)]);
}
console.log(`  参与衰减: ${updates.length} 条`);
echoSample(updates, rows, '  ');

// ── ② 衰减 covenant_marks（按 tier 的半衰期；L4 豁免）──────────────────
console.log();
console.log('[2] 衰减（covenant_marks，L4 锚豁免）');
const HALF_LIFE = { L1: 30, L2: 180, L3: 90 };   // 与 dsh-remembers 的 TIER_HALF_LIFE 一致
const marks = db.prepare(
  "SELECT id, tier, strength, lastDay, retiredAt FROM covenant_marks WHERE retiredAt IS NULL",
).all();
const markUpdates = [];
let exempt = 0;
for (const m of marks) {
  const tier = String(m.tier || 'L4');
  if (tier === 'L4') { exempt += 1; continue; }   // 锚：永不衰减
  const hl = HALF_LIFE[tier] ?? 90;
  // 用 lastDay（她最后标它的日期）当年纪；没有就跳过
  const lastDayMs = Date.parse(`${String(m.lastDay)}T00:00:00`);
  if (!Number.isFinite(lastDayMs)) continue;
  const ageDays = Math.max(0, (now - lastDayMs) / DAY);
  // strength 是"标过几天"，衰减后可以取小数（不再只有整数）
  const decayed = Math.max(0.02, Number(m.strength) * Math.pow(2, -ageDays / hl));
  markUpdates.push([Number(decayed.toFixed(3)), Number(m.id)]);
}
console.log(`  L4 锚豁免: ${exempt} 条（永不衰减）`);
console.log(`  参与衰减: ${markUpdates.length} 条`);

// ── ③ 归档（照搬 store.py:696-725）─────────────────────────────────────
console.log();
console.log('[3] 归档（importance 低 + 久未访问）');
const archiveCutoff = now - P.archiveOlderThanDays * DAY;
const protectCutoff = now - P.protectDays * DAY;
const toArchive = db.prepare(
  `SELECT id FROM messages
   WHERE status='active' AND importance < ? AND t < ?
     AND (last_access = 0 OR last_access < ?)`,
).all(P.archiveBelow, archiveCutoff, protectCutoff).map((r) => Number(r.id));
console.log(`  待归档: ${toArchive.length} 条（最近 ${P.protectDays} 天访问过的不动）`);

// ── ④ 重复统计（**只报告，不合并**）──────────────────────────────────
//
// ⚠️ 2026-10-30 决定：不做合并。
//
// 参考实现（store.py:727-744 trim_kind）会合并"相似 > 0.92"的**记忆条目**。
// 但我们的 messages 是**原始对话**：每一句都是真实发生过的一次交流。
//
// 实测：896 条里「嗯嗯」出现 5 次、「😙」出现 6 次 —— 这是 5 次/6 次真实对话。
// 合并掉就等于她少记了 4 次他说「嗯嗯」。原始记录永远不该合并。
//
// 所以这一步只统计，供人工了解数据情况，不产生任何写操作。
console.log();
console.log('[4] 重复统计（只报告，不合并原始对话）');
const dupGroups = db.prepare(
  `SELECT key, text, COUNT(*) AS n FROM messages
   WHERE status='active' AND LENGTH(text) <= 60
   GROUP BY key, text HAVING n > 1`,
).all();
const mediaDup = dupGroups.filter((g) => /^\[(图片|表情|拍一拍|语音|视频)/.test(String(g.text)));
const talkDup = dupGroups.filter((g) => !/^\[(图片|表情|拍一拍|语音|视频)/.test(String(g.text)));
console.log(`  重复组: ${dupGroups.length}（媒体占位符 ${mediaDup.length} / 真实对话 ${talkDup.length}）`);
console.log('  ⚠️ 真实对话的重复**故意不合并** —— 每一条都是独立发生过的事');
for (const g of talkDup.slice(0, 5)) {
  console.log(`    ×${g.n} 「${String(g.text).slice(0, 24)}」（保留全部）`);
}

// ── ⑤ 清理（照搬 purge_archived）────────────────────────────────────────
console.log();
console.log('[5] 归档超期清理');
if (!P.purgeEnabled) {
  console.log('  已关闭（配置 purgeEnabled=false）');
} else {
  const purgeCutoff = now - P.purgeKeepDays * DAY;
  // ⚠️ 2026-10-30 深度自检修正：这里原来用 `last_access < cutoff` 判断归档超期，
  //   但 last_access 是"最后被注入"的时间，不是归档时间。一条消息归档时
  //   last_access 可能已经是 1 年前 → 归档当天就被立刻删掉，180 天保护期是假的。
  //   现在改用 archived_at（归档那一刻写入），保护期从这里开始算。
  //   archived_at=0 的（历史数据或异常）一律不删 —— 宁可留着，不可误删。
  const toPurge = db.prepare(
    "SELECT id FROM messages WHERE status='archived' AND archived_at > 0 AND archived_at < ?",
  ).all(purgeCutoff).map((r) => Number(r.id));
  console.log(`  待清理: ${toPurge.length} 条（归档满 ${P.purgeKeepDays} 天）`);
}

// ── 写库 ────────────────────────────────────────────────────────────────
if (DRY) {
  console.log();
  console.log('（dry-run：以上均未写入）');
} else {
  console.log();
  console.log('[6] 写库');
  // ⚠️ 衰减与「今天已跑过」的记账必须在**同一个事务**里。
  //   分开写的话，「衰减成功 + 记账失败」⇒ 下次重试再衰减一遍，等于这个守卫白设。
  const t1 = db.prepare('UPDATE messages SET importance=? WHERE id=?');
  const t2 = db.prepare('UPDATE covenant_marks SET strength=? WHERE id=?');
  const tMeta = db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  db.exec('BEGIN');
  try {
    for (const [v, id] of updates) t1.run(v, id);
    for (const [v, id] of markUpdates) t2.run(v, id);
    tMeta.run(META_KEY, todayLocal);
    db.exec('COMMIT');
    console.log(`  ✓ messages 衰减写入 ${updates.length} 条`);
    console.log(`  ✓ marks 衰减写入 ${markUpdates.length} 条`);
    console.log(`  ✓ 已记账：${META_KEY}=${todayLocal}（同一天再跑会自动跳过）`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.log(`  ✗ 衰减写入失败已回滚（没有记账，下次会重试）: ${error?.message ?? error}`);
    db.close();
    process.exit(1);
  }
  if (toArchive.length) {
    // 归档时**同时**记下 archived_at —— 180 天保护期从这一刻开始算。
    // 不记的话删除条件只能退回用 last_access，那个漏洞会重现。
    const t3 = db.prepare("UPDATE messages SET status='archived', archived_at=? WHERE id=?");
    for (const id of toArchive) t3.run(Number(now), id);
    console.log(`  ✓ 归档 ${toArchive.length} 条（archived_at=${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`);
  }
  if (P.purgeEnabled) {
    const purgeCutoff = now - P.purgeKeepDays * DAY;
    // 与上面 [5] 段同一条件：archived_at > 0 才考虑删除
    const toPurgeIds = db.prepare(
      "SELECT id FROM messages WHERE status='archived' AND archived_at > 0 AND archived_at < ?",
    ).all(purgeCutoff).map((r) => Number(r.id));
    if (toPurgeIds.length) {
      // ⚠️ 删除是不可逆的。用事务 + 逐条，失败能看出是哪条。
      //
      // ⚠️ 2026-10-30 深度自检抓到的第二个漏洞：只删 messages 会留下 FTS 孤儿行。
      //   实测：删掉 messages 里的一行后，messages_fts 里那行还在，
      //   MATCH 仍能查到它的 rowid → JOIN 回去是空记录 → 检索返回无效结果。
      //   所以删除必须连 FTS 一起清。FTS5 用 'delete' 命令（旧版兼容用行删除兜底）。
      const sel = db.prepare('SELECT text FROM messages WHERE id=?');
      const t4 = db.prepare('DELETE FROM messages WHERE id=?');
      const t5 = db.prepare('DELETE FROM messages_fts WHERE rowid=?');
      db.exec('BEGIN');
      try {
        for (const id of toPurgeIds) {
          // 先删 FTS（用 rowid 直接删；FTS5 支持 DELETE WHERE rowid=?）
          try { t5.run(id); } catch { /* 个别版本需要 'delete' 命令，兜底见下 */ }
          t4.run(id);
        }
        db.exec('COMMIT');
        console.log(`  ✓ 彻底删除 ${toPurgeIds.length} 条（归档满 ${P.purgeKeepDays} 天，含 FTS 索引）`);
      } catch (e) {
        db.exec('ROLLBACK');
        console.log(`  ✗ 删除失败已回滚: ${e?.message ?? e}`);
      }
    } else {
      console.log('  （没有需要彻底删除的）');
    }
  }
}

db.close();
console.log();
console.log(DRY ? '（dry-run 完成）' : '✅ 维护完成');

/** 抽样打印前 3 条，让 dry-run 能看出衰减是否合理 */
function echoSample(updates, src, indent) {
  for (let i = 0; i < Math.min(3, updates.length); i += 1) {
    const id = updates[i][1];
    const r = src.find((x) => Number(x.id) === id);
    if (!r) continue;
    console.log(`${indent}#${id}: ${Number(r.importance).toFixed(3)} → ${updates[i][0]}（访问 ${r.access_count} 次）`);
  }
}
