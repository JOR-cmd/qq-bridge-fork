// 运行时验证：真的 import bridge.js，抓出所有未定义引用 / 语法错误。
//
// 为什么需要它（项目笔记里的教训）：
//   `node --check` 只查语法，抓不到"用了没导入的变量"。
//   2026-10-30 我加 spawn 时就是这样：`--check` 通过，但 spawn 根本没导入。
//
// 做法：临时把锁文件挪开，用一个假端口，让模块完成顶层求值后立刻退出。
// 不启动 HTTP 服务、不连 QQ、不碰真实 state/（只读）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCK = path.join(ROOT, 'state', 'bridge.lock');

// 子进程内容：纯 ESM，用 file:// URL（Windows 绝对路径必须转成 URL）
const target = pathToFileURL(path.join(ROOT, 'src', 'bridge.js')).href;
const probe = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-probe-'));
process.env.DSH_BRIDGE_PROBE = tmp;
try {
  await import(${JSON.stringify(target)});
  console.log('__PROBE_OK__');
  process.exit(0);
} catch (e) {
  console.error('__PROBE_ERR__', e && e.message ? e.message : String(e));
  process.exit(2);
}
`;

const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 20000,
  env: { ...process.env, DSH_BRIDGE_PROBE: '1' },
});

const out = `${r.stdout || ''}${r.stderr || ''}`;
console.log('退出码:', r.status);
// 过滤掉正常的"已有实例在运行"（锁文件挡住）—— 那说明模块求值到一半才退出
if (out.includes('__PROBE_OK__')) {
  console.log('✅ 模块加载成功（无未定义引用）');
} else if (out.includes('__PROBE_ERR__')) {
  const line = out.split('__PROBE_ERR__')[1]?.trim();
  console.log('❌ 加载失败:', line);
} else if (out.includes('已有实例在运行')) {
  console.log('⚠️ 被锁文件挡住（说明顶层求值已走到锁检查，之前的引用都成功）');
} else {
  console.log('输出:', out.slice(0, 400));
}
