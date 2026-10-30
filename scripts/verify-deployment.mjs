// 部署后验证：确认桥接进程加载的是新代码（不是"文件改了但没生效"）。
//
// 这项目反复吃过这个亏：改了代码、测试过了，但忘了重启，她那边跑的还是旧的。
// 这里用两个不依赖重启的客观证据：
//   ① 进程启动时间 > 文件修改时间
//   ② 桥接日志里出现了新功能才有的日志行
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = [
  'src/bridge.js', 'src/emotion-pad.mjs', 'src/covenant-inject.mjs',
  'src/covenant-store.mjs', 'src/archive-store.mjs', 'src/recall.mjs',
  'scripts/decay-memory.mjs',
];

const mtime = (f) => fs.statSync(path.join(ROOT, f)).mtimeMs;
let newest = 0;
console.log('=== 代码文件最后修改时间 ===');
for (const f of files) {
  const t = mtime(f);
  newest = Math.max(newest, t);
  console.log(`  ${new Date(t).toLocaleString('zh-CN', { hour12: false })}  ${f}`);
}

// 桥接启动时间：从 lock 文件
const lockPath = path.join(ROOT, 'state', 'bridge.lock');
const lockTime = fs.existsSync(lockPath) ? fs.statSync(lockPath).mtimeMs : 0;
console.log();
console.log('=== 桥接启动时间 ===');
console.log(`  ${new Date(lockTime).toLocaleString('zh-CN', { hour12: false })}`);

console.log();
console.log('=== 判断 ===');
if (!lockTime) {
  console.log('⚠️ 找不到 lock 文件（桥可能没在跑）');
} else if (lockTime > newest) {
  console.log('✅ 桥接启动时间晚于所有代码修改 → 加载的是新代码');
} else {
  const gap = Math.round((newest - lockTime) / 1000);
  console.log(`❌ 有代码比桥接更新（晚 ${gap} 秒）→ 需要重启`);
}

// 日志证据
const logPath = path.join(ROOT, 'state', 'bridge.log');
if (fs.existsSync(logPath)) {
  const log = fs.readFileSync(logPath, 'utf8');
  const since = lockTime ? log.lastIndexOf('\n', log.length) : 0;
  const tail = lockTime ? log.slice(log.lastIndexOf('桥接已启动')) : log;
  console.log();
  console.log('=== 新功能日志证据 ===');
  const evidence = [
    ['[memory] 每日维护已排程', '记忆维护调度器'],
    ['[emotion]', '情绪层（出现即说明跑过 apply）'],
    ['[契阔·', '锚重构相关'],
  ];
  for (const [needle, label] of evidence) {
    const hit = tail.includes(needle);
    console.log(`  ${hit ? '✓' : '·'} ${label}${hit ? '（已出现）' : '（本次启动后还没触发）'}`);
  }
}
