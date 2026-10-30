// 只读：统计 qq-chat-v2 预设正文真实字符数，并核对交接单声称的 9541 字符。
import fs from 'node:fs';

const paths = [
  'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml',
  'dsh/agent-presets/qq-chat-v2.patch.yml',
  'patches/files/dsh/agent-presets/qq-chat-v2.patch.yml',
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
];

for (const p of paths) {
  if (!fs.existsSync(p)) { console.log(p, '-> 不存在'); continue; }
  const s = fs.readFileSync(p, 'utf8');
  const lines = s.split('\n');
  const prose = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;              // 注释
    if (t.startsWith('- id:') || t.startsWith('- insert:')) continue; // YAML 结构
    if (/^[\w.$-]+:\s*$/.test(t)) continue;        // 纯键
    prose.push(t);
  }
  const body = prose.join('\n');
  console.log('──', p);
  console.log('   文件字符数 :', [...s].length, '  字节:', Buffer.byteLength(s));
  console.log('   正文估算   :', [...body].length);
  for (const k of ['先有情绪，再谈简洁', '条数跟着内容走', '多数只发 1 条', '多数普通对话只发 1 条', '你没有本地工具']) {
    if (s.includes(k)) console.log('   ✓ 含:', k);
  }
}
