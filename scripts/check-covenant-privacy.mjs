// 扫描契阔里有没有敏感信息（只读）。
import { CovenantStore } from '../src/covenant-store.mjs'

const store = new CovenantStore('state/archive.db')
const all = store.letters('private:<OWNER_QQ>', 60)
const text = all.map((l) => l.text).join('\n')

console.log('信的字数:', text.length, '\n')

const checks = [
  ['QQ号(6-12位)', /\b\d{6,12}\b/],
  ['手机号', /1[3-9]\d{9}/],
  ['身份证', /\d{17}[\dXx]/],
  ['token/key', /(token|api[_-]?key|secret|密码|口令)/i],
  ['邮箱', /[\w.-]+@[\w.-]+\.\w+/],
  ['Windows路径', /(?:[A-Za-z]:[\\/]|\\Users\\)/],
  ['URL', /https?:\/\//],
]

let found = 0
for (const [name, re] of checks) {
  const m = text.match(re)
  if (m) { found += 1; console.log(`  ⚠ ${name.padEnd(14)} 发现: ${String(m[0]).slice(0, 50)}`) }
  else console.log(`  ✓ ${name.padEnd(14)} 无`)
}

console.log('\n结论:', found ? `发现 ${found} 类，需要脱敏` : '当前没有敏感信息，但**未来可能写进去**')
store.close()
