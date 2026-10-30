import fs from 'node:fs'

const p = 'src/covenant-inject.mjs'
let s = fs.readFileSync(p, 'utf8')
const i = s.indexOf('export function compressCovenantBlock')
const oldFn = s.slice(i)

const newFn = `export function compressCovenantBlock(text, maxChars = 0) {
  const src = String(text ?? '');
  const before = [...src].length;
  const max = Number(maxChars) || 0;
  if (!max || before <= max) return { text: src, compressed: false, before, after: before };

  // ⚠ 按**段落**切，不按字符切（2026-10-29 抓出来的两个坑）：
  //   ① 按字符切会劈开句子，得到「正正正正…」这种乱码；
  //   ② 按行切还不够 —— 尾部预算会把「要记牢」的**前几条**截掉，
  //      而那些恰恰是她亲手标的、最不能丢的。
  //
  // 所以先按空行分段，再判断哪些段必须留：
  //   · 【契阔·最近 N 封】  → 会长（可以压）
  //   · 【契阔·你标过要记牢的】/【对不上】/【该回来看看】 → **必须整段保留**
  // 压的时候只压「最近 N 封」那一段，其余原样接上。
  const blocks = src.split(/\\n\\n+/).filter((b) => b.trim());
  const lettersBlock = blocks.find((b) => b.startsWith('【契阔·最近'));
  const mustKeep = blocks.filter((b) => !b.startsWith('【契阔·最近'));

  // 必须保留的部分本身有多长
  const keepLen = [...mustKeep.join('\\n\\n')].length + 2 * 4;
  // 分给信件段/单封信的预算：至少留 40% 给信，否则压缩就没意义了
  const lettersBudget = Math.max(60, max - keepLen);
  if (lettersBudget <= 60) {
    // 预算实在太小：连信都放不下，那就只留必须保留的部分
    const out = \`…（契阔太长，最近的信这次没念）…\\n\\n\${mustKeep.join('\\n\\n')}\\n\\n\`;
    return { text: out, compressed: true, before, after: [...out].length };
  }

  let squeezedLetters = '';
  if (lettersBlock) {
    const lines = lettersBlock.split('\\n');
    // 第一行是标题，后面每行是一封信（或"更早还有"提示）
    const header = lines[0];
    const body = lines.slice(1);
    let acc = \`\${header}\\n\`;
    let used = [...acc].length;
    for (const line of body) {
      const need = [...line].length + 1;
      if (used + need > lettersBudget) break;
      acc += \`\${line}\\n\`;
      used += need;
    }
    squeezedLetters = \`\${acc}…（契阔太长，更早日期的信已省略；它们的事凡是你标过要记牢的，都还在下面）…\`;
  }

  const out = \`\${squeezedLetters}${squeezedLetters ? '\\n\\n' : ''}\${mustKeep.join('\\n\\n')}\\n\\n\`;
  return { text: out, compressed: true, before, after: [...out].length };
}
`

s = s.slice(0, i) + newFn
fs.writeFileSync(p, s, 'utf8')
console.log('✓ 压缩改为按段落：必须保留的段（要记牢/孤儿/待回访）整段不动')
