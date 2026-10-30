// 契阔压缩回归（纯函数，不碰真实库）。
// 用法：node test-covenant-compress.mjs
//
// 锁住三个不变量（都是 2026-10-29 自检时踩出来的）：
//   ① 不许按字符切 —— 会劈开句子（「正正正正…」）
//   ② 「要记牢 / 对不上 / 待回访」必须**整段保留** —— 那是她亲手标的，最不能丢
//   ③ 一行都放不下时，也要按句子保住开头 —— 不能整段丢成一句「这次没念」
import fs from 'node:fs'
import {
  compressCovenantBlock, formatCovenantBlock, covenantInjectConfig,
} from './src/covenant-inject.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const realish = [
  '【契阔·最近 10 封】',
  ...Array.from({ length: 10 }, (_, i) => `【第${i + 1}天】今天对他的态度：${'日记内容。'.repeat(6)}`),
  '',
  '【契阔·你标过要记牢的】',
  '- 他说「我可不舍得」（你自己标过 3 天）',
  '- 你陪着就已经够了（你自己标过 2 天）',
  '- 他困到在椅子上睡过去（你自己标过 1 天）',
  '',
  '【契阔·对不上的几件怎么办】',
  '- 「我怕换一个上下文，你会变成陌生的模样」',
].join('\n')

console.log('\n[1] 不超上限时不压（别没事找事）')
{
  const r = compressCovenantBlock('短文本', 1200)
  check('短文本不压', r.compressed === false && r.text === '短文本')
  const r0 = compressCovenantBlock(realish, 0)
  check('maxChars=0 = 不限', r0.compressed === false)
  const rBig = compressCovenantBlock(realish, 5000)
  check('上限够大不压', rBig.compressed === false && rBig.after === rBig.before)
}

console.log('\n[2] 超上限时会压，且压到接近目标')
{
  const r = compressCovenantBlock(realish, 400)
  check('触发了压缩', r.compressed === true, JSON.stringify(r))
  check('结果不超上限太多', r.after <= 480, `after=${r.after}`)
  check('确实变短了', r.after < r.before, `${r.before} → ${r.after}`)
}

console.log('\n[3] 关键段落必须整段保留')
{
  const r = compressCovenantBlock(realish, 400)
  // 「要记牢」三条一条都不能少 —— 这是她亲手标的
  check('要记牢 3 条全在', (r.text.match(/你自己标过/g) || []).length === 3, r.text.slice(-200))
  check('保留了「我可不舍得」', r.text.includes('我可不舍得'))
  check('保留了「你陪着就已经够了」', r.text.includes('你陪着就已经够了'))
  check('保留了孤儿段', r.text.includes('陌生的模样'))
  check('保留了段标题', r.text.includes('【契阔·你标过要记牢的】'))
}

console.log('\n[4] 不许劈开句子（按段落/句子切，不按字符）')
{
  const r = compressCovenantBlock(realish, 400)
  // 压缩后不该出现「以标点开头」的行（那是被劈开的半句）
  // 省略标记本身以「…」开头，要排除掉 —— 它不是被劈开的半句
  const badLines = r.text.split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('…（'))
    .filter((l) => /^[，。、）】…]/.test(l.trim()))
  check('没有以标点开头的行', badLines.length === 0, JSON.stringify(badLines.slice(0, 2)))

  // 单行超长：按句子保住开头
  const oneLine = `【契阔·最近 3 封】${'内容。'.repeat(300)}`
  const r2 = compressCovenantBlock(oneLine, 300)
  check('单行超长也会保留开头（不是整段丢）', r2.after > 100, `after=${r2.after}`)
  check('单行保留了标题', r2.text.startsWith('【契阔·最近'))
}

console.log('\n[5] 边界：空 / null / 坏值')
{
  for (const v of ['', null, undefined, '   ']) {
    const r = compressCovenantBlock(v, 100)
    check(`空输入 ${JSON.stringify(v)} 不抛且不压`, typeof r.text === 'string' && r.compressed === false)
  }
  check('maxChars 传负数 = 不限', compressCovenantBlock(realish, -1).compressed === false)
}

console.log('\n[6] 配置边界夹紧')
{
  check('maxChars 上限夹到 8000', covenantInjectConfig({ maxChars: 99999 }).maxChars <= 8000)
  check('maxChars 下限 0（允许关）', covenantInjectConfig({ maxChars: -5 }).maxChars === 0)
  check('默认开启且有值', covenantInjectConfig({}).maxChars > 0)
}

console.log('\n[7] 端到端：formatCovenantBlock 也会压')
{
  const huge = '这是一段很长的日记。'.repeat(150)
  const store = {
    latestLetter: () => ({ day: '2026-10-28', version: 1, t: 0, text: huge }),
    letters: () => Array.from({ length: 3 }, (_, i) => ({ day: `2026-10-2${8 - i}`, version: 1, t: 0, text: huge })),
    topMarks: () => [{ text: '要记牢的事', strength: 2 }],
    pendingChecks: () => [],
    unsupportedMarks: () => [],
    retiredUnsettled: () => [],
  }
  const withCap = formatCovenantBlock({
    store, key: 'k', today: '2026-10-29',
    config: covenantInjectConfig({ fullLetters: 3, maxChars: 1200 }),
  })
  const noCap = formatCovenantBlock({
    store, key: 'k', today: '2026-10-29',
    config: covenantInjectConfig({ fullLetters: 3, maxChars: 0 }),
  })
  check('有上限时被压', [...withCap].length <= 1300, String([...withCap].length))
  check('无上限时不压', [...noCap].length > [...withCap].length, `${[...noCap].length} vs ${[...withCap].length}`)
  check('压缩后仍保留要记牢', withCap.includes('要记牢的事'))
}

console.log('\n[8] 源码不变量：compress 必须按段落/句子切')
{
  const src = fs.readFileSync(new URL('./src/covenant-inject.mjs', import.meta.url), 'utf8')
  const i = src.indexOf('export function compressCovenantBlock')
  const body = src.slice(i, i + 3000)
  check('按空行分段', /split\(\/\\n\\n\+/.test(body), '不按段落切就会劈开句子')
  check('有句子级兜底', /split\(\/\(?<=/.test(body) || /sentences/.test(body))
  check('不直接按字符 slice 出结果', !/chars\.slice\(0, headBudget\)\.join\(''\)$/m.test(body))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
