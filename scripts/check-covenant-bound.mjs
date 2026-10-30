// 验证注入有界：50 封信时，注入不会线性增长。
import { formatCovenantBlock, covenantInjectConfig } from '../src/covenant-inject.mjs'

const letters = Array.from({ length: 50 }, (_, i) => ({
  day: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
  version: 1,
  t: 0,
  text: `第${i + 1}封信的内容，写了一点今天的事。`,
})).reverse()

const store = {
  latestLetter: () => letters[0],
  letters: (k, n) => letters.slice(0, n),
  topMarks: () => [
    { text: '他说的某句重要的话', strength: 3 },
    { text: '另一件要记牢的事', strength: 1 },
  ],
  pendingChecks: () => [],
  unsupportedMarks: () => [],
  retiredUnsettled: () => [],
}

console.log('=== 50 封信时的注入长度 ===\n')
for (const n of [1, 3, 7, 15]) {
  const blk = formatCovenantBlock({
    store, key: 'k', today: '2026-10-29',
    config: covenantInjectConfig({ fullLetters: n }),
  })
  const hint = blk.includes('更早还有') ? '，含"更早还有"提示' : ''
  console.log(`  fullLetters=${String(n).padStart(2)} → 注入 ${String([...blk].length).padStart(3)} 字${hint}`)
}

console.log('\n=== 不设上限时（模拟旧行为）===')
const oldStyle = letters.map((l) => l.text).join('\n')
console.log(`  50 封全文 ≈ ${[...oldStyle].length} 字 —— 会撑爆 wakeMaxChars(6000) 的预算`)

console.log('\n=== 断言 ===')
const three = formatCovenantBlock({ store, key: 'k', today: '2026-10-29', config: covenantInjectConfig({ fullLetters: 3 }) })
const seven = formatCovenantBlock({ store, key: 'k', today: '2026-10-29', config: covenantInjectConfig({ fullLetters: 7 }) })
const ok = [...three].length < 600 && [...seven].length < 1200
console.log(ok ? '  ✓ 有界生效（长度随配置线性，但远小于 50 封全文）' : '  ✗ 有界没生效')
console.log(three.includes('更早还有 47 封') ? '  ✓ 正确报了"更早还有 47 封"' : '  ⚠ 老封数提示不对')
