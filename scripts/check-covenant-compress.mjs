// 验证契阔压缩：构造超长内容，确认头尾保留、中间压掉。
import { compressCovenantBlock, formatCovenantBlock, covenantInjectConfig } from '../src/covenant-inject.mjs'

console.log('=== 直接测 compressCovenantBlock ===\n')
const long = [
  '【契阔·最近 5 封】',
  ...Array.from({ length: 5 }, (_, i) => `【第${i + 1}封】这是第${i + 1}封的内容，ABCXYZ${i}`.padEnd(180, '正')),
  '',
  '【契阔·你标过要记牢的】',
  '- 他说「我可不舍得」（你自己标过 3 天）',
  '- 你陪着就已经够了（你自己标过 2 天）',
  '',
  '【契阔·对不上的几件怎么办】',
  '- 「我怕换一个上下文」',
].join('\n')
console.log('原文:', [...long].length, '字')

for (const max of [400, 800, 1200, 0]) {
  const r = compressCovenantBlock(long, max)
  const tag = max === 0 ? '不限' : `上限 ${max}`
  console.log(`  ${tag.padEnd(10)} → ${String(r.after).padStart(4)} 字  ${r.compressed ? '（已压）' : '（未压）'}`)
}

console.log('\n=== 压缩后头尾是否保留 ===')
const squeezed = compressCovenantBlock(long, 400)
console.log('  头部含「最近 5 封」:', squeezed.text.includes('最近 5 封'))
console.log('  尾部含「我可不舍得」:', squeezed.text.includes('我可不舍得'))
console.log('  尾部含「我怕换一个上下文」:', squeezed.text.includes('我怕换一个上下文'))
console.log('  含省略标记:', squeezed.text.includes('已省略'))
console.log()
console.log('  压缩后全文（前 120 字）：')
console.log('  ' + squeezed.text.slice(0, 120).replace(/\n/g, ' ⏎ '))
console.log('  …')
console.log('  ' + squeezed.text.slice(-160).replace(/\n/g, ' ⏎ '))

console.log('\n=== 真实 formatCovenantBlock 是否会压缩 ===')
// 假 store 造超长信
const huge = '这是一封很长的信。'.repeat(200)
const store = {
  latestLetter: () => ({ day: '2026-10-28', version: 1, t: 0, text: huge }),
  letters: () => Array.from({ length: 3 }, (_, i) => ({ day: `2026-10-2${8 - i}`, version: 1, t: 0, text: huge })),
  topMarks: () => [{ text: '要记牢的事', strength: 2 }],
  pendingChecks: () => [],
  unsupportedMarks: () => [],
  retiredUnsettled: () => [],
}
for (const max of [1200, 0]) {
  const blk = formatCovenantBlock({
    store, key: 'k', today: '2026-10-29',
    config: covenantInjectConfig({ fullLetters: 3, maxChars: max }),
  })
  console.log(`  maxChars=${String(max).padStart(4)} → ${String([...blk].length).padStart(5)} 字  ${blk.includes('已省略') ? '（已压）' : '（未压）'}`)
}
