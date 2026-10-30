// 验证契阔脱敏（只测纯函数，不碰真实库）。
import { redactForCovenant, hasPrivateNumbers } from '../src/covenant-redact.mjs'
import { formatCovenantBlock, covenantInjectConfig } from '../src/covenant-inject.mjs'

console.log('=== 脱敏规则 ===')
const cases = [
  ['我的手机 13812345678 记一下', '手机号'],
  ['身份证 110101199001011234 别忘了', '身份证'],
  ['卡号 6222021234567890123 别告诉别人', '卡号'],
  ['他说 3387128282 这个号', 'QQ号（应保留）'],
  ['第 3 封信写得很长', '普通数字（应保留）'],
  ['2026-10-28。今天很好', '日期（应保留）'],
]
for (const [input, label] of cases) {
  const out = redactForCovenant(input)
  const changed = out !== input
  const shouldChange = label !== 'QQ号（应保留）' && label !== '普通数字（应保留）' && label !== '日期（应保留）'
  const ok = changed === shouldChange
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(16)} ${changed ? `→ ${out}` : '（不变）'}`)
}

console.log('\n=== hasPrivateNumbers ===')
console.log('  含手机号:', hasPrivateNumbers('打 13812345678'))
console.log('  纯日期:', hasPrivateNumbers('2026-10-28'))

console.log('\n=== 注入侧：假 store 验证真的脱敏 ===')
const fakeStore = {
  latestLetter: () => ({ day: '2026-10-28', version: 1, t: Date.now(), text: '他给了手机号 13812345678，我记下了' }),
  letters: () => [{ day: '2026-10-28', version: 1, t: Date.now(), text: '他给了手机号 13812345678，我记下了' }],
  topMarks: () => [],
  pendingChecks: () => [],
  unsupportedMarks: () => [],
  retiredUnsettled: () => [],
}
const blk = formatCovenantBlock({
  store: fakeStore, key: 'private:1', today: '2026-10-28',
  config: covenantInjectConfig({ fullLetters: 1 }),
})
console.log(blk.trim())
console.log()
console.log(blk.includes('13812345678') ? '✗ 原文泄漏' : '✓ 注入侧已脱敏')
console.log(blk.includes('[手机号]') ? '✓ 占位符已插入' : '✗ 没有占位符')
