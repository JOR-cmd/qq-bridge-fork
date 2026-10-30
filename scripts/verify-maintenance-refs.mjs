// 严格验证：抽出新加的 startMemoryMaintenance 函数体，逐个核对标识符。
//
// 为什么必须这么查（2026-10-30 真实踩坑）：
//   我加了 spawn(...)，但文件顶部只 import 了 execFileSync。
//   `node --check` 通过、模块也能加载（因为函数体没执行），
//   只有真的跑到 00:10 那一刻才会 ReferenceError: spawn is not defined。
//
// 这正是项目笔记里记着的那条：「node --check 抓不到未定义变量」。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

// ① 取函数体
const start = src.indexOf('function startMemoryMaintenance(');
if (start < 0) { console.log('❌ 找不到 startMemoryMaintenance'); process.exit(1); }
// 用括号配平找函数结尾
let i = src.indexOf('{', start);
let depth = 0;
let end = -1;
for (; i < src.length; i += 1) {
  if (src[i] === '{') depth += 1;
  else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
}
const body = src.slice(start, end + 1);
console.log(`函数体长度: ${body.length} 字符`);

// ② 提取函数体里"用到的标识符"（粗略：identifier 后不跟 : = . ( 等）
const idents = new Set();
for (const m of body.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
  const name = m[1];
  // 跳过关键字 / 字面量 / 属性访问
  if (['function', 'if', 'return', 'const', 'let', 'var', 'try', 'catch', 'else', 'new', 'typeof', 'true', 'false', 'null', 'undefined', 'Number', 'String', 'Date', 'Math', 'JSON', 'console'].includes(name)) continue;
  idents.add(name);
}

// ③ 在**整个文件**里找定义（import / const / let / var / function / 参数）
const isDefined = (name) => {
  const patterns = [
    new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),   // 具名导入
    new RegExp(`import\\s+${name}\\s+from`),                        // 默认导入
    new RegExp(`import\\s*\\*\\s+as\\s+${name}`),                    // 命名空间
    new RegExp(`(const|let|var)\\s+${name}\\s*=`),                   // 变量
    new RegExp(`(const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`), // 解构
    new RegExp(`function\\s+${name}\\s*\\(`),                        // 函数声明
    new RegExp(`\\(.*\\b${name}\\b.*\\)\\s*=>`),                     // 箭头函数参数
  ];
  return patterns.some((re) => re.test(src));
};

// ④ 只检查"大写开头（常量）或已知全局之外的可疑项"
const builtins = new Set(['process', 'setInterval', 'clearTimeout', 'setTimeout', 'fs', 'path', 'os']);
const missing = [];
for (const name of idents) {
  if (builtins.has(name)) continue;
  if (/^[a-z]/.test(name) && !/[A-Z]/.test(name[0]) && name.length < 3) continue; // 太短的可能是属性
  if (!isDefined(name)) missing.push(name);
}

console.log();
if (missing.length) {
  console.log('⚠️ 可能未定义的标识符（需要人工确认）:');
  for (const n of missing) console.log('   ·', n);
} else {
  console.log('✅ 所有引用都有定义');
}

// ⑤ 重点：明确检查那三个容易漏的
console.log();
console.log('=== 关键依赖逐个确认 ===');
for (const [name, pattern] of [
  ['spawn', /import\s*\{[^}]*\bspawn\b[^}]*\}\s*from\s*'node:child_process'/],
  ['ROOT', /const\s+ROOT\s*=/],
  ['STATE_DIR', /const\s+STATE_DIR\s*=/],
  ['atomicWriteJson', /function\s+atomicWriteJson/],
  ['localDay', /import\s*\{[^}]*\blocalDay\b[^}]*\}/],
]) {
  console.log(`  ${pattern.test(src) ? '✓' : '✗'} ${name}`);
}
