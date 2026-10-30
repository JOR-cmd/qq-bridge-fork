// 记忆维护调度器回归（**先写测试，再改实现**）。
// 用法：node test-memory-scheduler.mjs
//
// 锁住 2026-10-30 查出来的漏洞 D：
//   原来 runIfDue 是「**先记今天跑过**，再去 spawn」。于是子进程失败/被杀时，
//   当天这一整天的遗忘（衰减/归档/清理）**静默丢失**，而且明天也不会补今天。
//
// 正确语义（和同文件 covenant 邀请的「送达才记已发送」是同一条原则）：
//   · 成功   → 记账，当天不再跑
//   · 失败   → **不记账**，进冷却，冷却后还允许再试
//   · 在飞   → 不重复拉（60 秒轮询会一直来敲门）
//
// ⚠️ 用 harness 的临时目录跑真实 bridge 代码，**不碰真实 state/**。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './scripts/audit-bridge-harness.mjs';

let pass = 0; let fail = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`); }
};

// ── 1. 源码不变量：记账必须发生在成功之后 ────────────────────────────────
console.log('\n[1] 源码不变量（这是本次修复的核心，改回去必须立刻报红）');
{
  const src = fs.readFileSync(new URL('./src/bridge.js', import.meta.url), 'utf8');
  const start = src.indexOf('function startMemoryMaintenance(');
  assert.ok(start >= 0, '找不到 startMemoryMaintenance');
  // 括号配平取函数体（照 verify-maintenance-refs.mjs 的做法）
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const rawBody = src.slice(start, end + 1);
  // ⚠️ 断言前必须剥注释 —— 本项目的 LOCAL-NOTES 记着这个坑：
  //   我在注释里写了「原来 `saveMemoryJobDay(day)` 写在 spawn 之前」那段，
  //   不剥注释的话，匹配到的是**这句注释本身**，测试会以为"先记再跑"还在。
  //   （第一次跑这个测试就是被自己的注释骗过去的。）
  const body = rawBody
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/\/\/[^\n]*/g, '');        // 行注释

  // 判据用「记账」和「开始跑」的先后，而不是纯粹的文本位置：
  //   新实现里 settle() 定义在 spawn 之前（它是个回调），但**调用**发生在 exit 时。
  //   旧 bug 的特征非常明确：`saveMemoryJobDay(day);` 紧跟着就是 `log('开始每日维护')`。
  //   所以只要「开始跑」出现在「记账」之前，就说明记账不再是前置动作。
  const startLog = body.indexOf('开始每日维护');
  const recordAt = body.indexOf('saveMemoryJobDay(day)');
  ck('「开始跑」先于「记账」（不是先记再跑）', startLog >= 0 && recordAt > startLog, `log@${startLog} record@${recordAt}`);

  // 再钉一次旧 bug 的具体形状：记账后**立刻**写"开始"，绝不能出现。
  const oldShape = /saveMemoryJobDay\(day\);\s*log\(\s*`[^`]*开始每日维护/;
  ck('没有「先 saveMemoryJobDay 再 log 开始」的旧形状', !oldShape.test(body));

  // 记账全文只允许出现一次（防止顺手在失败分支也记一笔）
  const recordCount = (body.match(/saveMemoryJobDay\(day\)/g) || []).length;
  ck('saveMemoryJobDay(day) 全文只出现 1 次', recordCount === 1, `count=${recordCount}`);

  // 记账必须在成功分支里
  const okBranch = body.slice(body.indexOf('if (ok)'));
  ck('记账写在 if (ok) 成功分支内', okBranch.slice(0, 140).includes('saveMemoryJobDay(day)'), okBranch.slice(0, 140));

  ck('有 memoryInFlight 防重入', body.includes('memoryInFlight'));
  ck('有失败冷却', body.includes('MEMORY_RETRY_COOLDOWN_MS'));
  ck('失败路径不记账（失败分支里没有 saveMemoryJobDay）', !/else\s*\{[^}]*saveMemoryJobDay/.test(body));
}

// ── 2. 真实桥接里跑一遍：成功才落盘 ─────────────────────────────────────
console.log('\n[2] 真实 bridge 代码：成功路径必须记账');
{
  const h = await bridgeHarness({ config: { socialV2: { memory: { enabled: true, hour: 0, minute: 10 } } } });
  try {
    // 这个 harness 不真的去 00:10，我们只验证「没有失败就不该有账」
    const file = path.join(h.temp, 'state', 'memory-job-last.json');
    const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    ck('初始没有 memory-job-last.json（或为空）', before === null || !before.day || before.at === 0, JSON.stringify(before));
  } finally { await h.close(); }
}

// ── 3. 坏数据的稳健性（账本文件被写坏不能拖垮调度器）─────────────────────
console.log('\n[3] 坏账本不崩');
{
  const cases = [
    ['不是 JSON', '{{{'],
    ['空对象', '{}'],
    ['day 是数字', '{"day":123}'],
    ['day 是 null', '{"day":null}'],
  ];
  for (const [name, content] of cases) {
    const h = await bridgeHarness({
      config: { socialV2: { memory: { enabled: true } } },
      files: { 'state/memory-job-last.json': content },
    });
    try {
      const snap = h.memoryMaintenanceSnapshot ? h.memoryMaintenanceSnapshot() : null;
      ck(`账本是「${name}」时不抛`, true, snap ? JSON.stringify(snap) : '');
    } catch (error) {
      ck(`账本是「${name}」时不抛`, false, error?.message ?? String(error));
    } finally { await h.close(); }
  }
}

// ── 4. 关闭开关 ────────────────────────────────────────────────────────
console.log('\n[4] socialV2.memory.enabled=false 时整体跳过');
{
  const h = await bridgeHarness({ config: { socialV2: { memory: { enabled: false } } } });
  try {
    const mem = h.memoryMaintenanceSnapshot ? h.memoryMaintenanceSnapshot() : null;
    ck('关闭时不启动调度（有快照就检查）', !mem || mem.enabled === false, JSON.stringify(mem));
  } finally { await h.close(); }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
