// 目的引擎接入桥上之后的端到端自检（不联网、不发消息、不写真实 state/）。
// 用法：node test-intent-integration.mjs
//
// 这里测的是「接进去之后有没有把别的东西弄坏」：
//   · 配置默认值存在、能关掉
//   · 非 proactive 唤醒不注入（否则正常对话会被带跑）
//   · 落盘/加载往返：drives 不能重启就归零
//   · 脏数据不能让唤醒挂掉
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname)
const SRC = path.join(ROOT, 'src', 'bridge.js')
const code = fs.readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

console.log('\n[1] 配置默认值：能开、能关（不能是"永远开无法关闭"的黑盒）')
{
  const m = /intent:\s*\{([\s\S]{0,400}?)\}/.exec(code)
  check('socialV2 默认配置里有 intent 块', Boolean(m), '找不到 intent 配置')
  const body = m?.[1] ?? ''
  check('有 enabled 开关', /enabled\s*:/.test(body), body)
  check('有 maxLoops 上限', /maxLoops\s*:/.test(body), body)
  check('有 maxAgeHours（防止翻旧账）', /maxAgeHours\s*:/.test(body), body)
  check('代码真的读了 enabled', /intent\?\.enabled\s*===\s*false/.test(code))
  check('代码真的读了 maxLoops', /intent\?\.maxLoops/.test(code))
  check('代码真的读了 maxAgeHours', /intent\?\.maxAgeHours/.test(code))
}

console.log('\n[2] 只在 proactiveCheck 注入（这是最容易被改坏的一条）')
{
  const i = code.indexOf('function buildIntentLineV2')
  check('函数存在', i > 0)
  // 取到函数真正结束的位置（按大括号配平），别只截几百字符 —— 注释会把窗口撑爆。
  let depth = 0; let started = false; let end = i
  for (let k = i; k < code.length; k += 1) {
    if (code[k] === '{') { depth += 1; started = true }
    else if (code[k] === '}') { depth -= 1; if (started && depth === 0) { end = k; break } }
  }
  const body = code.slice(i, end)
  // 去掉行注释再检查，避免"注释里写了但代码没写"的假通过
  const noComment = body.replace(/\/\/[^\n]*/g, '')

  check('第一件事是清空上一轮痕迹', /st\.intentLoopTexts\s*=\s*\[\]/.test(noComment.slice(0, 300)), noComment.slice(0, 160))
  check('清空发生在"非 proactive 返回"之前',
    noComment.indexOf('st.intentLoopTexts = []') < noComment.indexOf("reason !== 'proactiveCheck'"),
    `clear@${noComment.indexOf('st.intentLoopTexts = []')} guard@${noComment.indexOf("reason !== 'proactiveCheck'")}`)
  check('非 proactive 立即返回空', /reason\s*!==\s*'proactiveCheck'\)\s*return\s*''/.test(noComment), noComment.slice(0, 260))
  check('有 try/catch 兜底（引擎坏了也不能让唤醒挂）', /try\s*\{/.test(noComment) && /catch/.test(noComment))
  check('catch 里返回空串而不是抛', /catch[\s\S]{0,200}return\s*''/.test(noComment), 'catch 没有兜底返回')
}

console.log('\n[3] 注入位置：拼进 base，且只拼一次')
{
  const baseLine = code.split('\n').find((l) => l.includes('const base = roleLine')) ?? ''
  check('base 拼接里有 intentLine', /\+\s*intentLine\b/.test(baseLine), baseLine.slice(0, 200))
  const n = (code.match(/\+\s*intentLine\b/g) || []).length
  check('只拼了一次', n === 1, `出现 ${n} 次`)
  check('intentLine 在 base 的最后（最显眼）', /\+\s*intentLine;\s*$/.test(baseLine.trim()), baseLine.slice(-80))
}

console.log('\n[4] 落盘 + 加载往返：drives 不能重启归零')
{
  check('保存里有 drives', /drives:\s*st\.drives/.test(code))
  check('保存里有 drivesAt', /drivesAt:\s*Number\(st\.drivesAt\)/.test(code))
  check('保存里有 purposeHistory', /purposeHistory:\s*Array\.isArray\(st\.purposeHistory\)/.test(code))
  check('加载里有 normalizeDrives', /drives:\s*normalizeDrives\(val\.drives\)/.test(code),
    '加载路径没有归一化会让脏数据进内存')
  check('加载里有 drivesAt', /drivesAt:\s*Number\(val\.drivesAt\)/.test(code))
  check('加载里有 purposeHistory 过滤', /purposeHistory:\s*Array\.isArray\(val\.purposeHistory\)/.test(code))
}

console.log('\n[5] 瞬态字段初始化（undefined 会让判断走偏）')
{
  check('初始化里有 intentLoopTexts', /intentLoopTexts:\s*\[\]/.test(code))
  check('加载路径也初始化了 intentLoopTexts', /intentLoopTexts:\s*\[\][\s\S]{0,80}purposeHistory/.test(code))
}

console.log('\n[6] 去重链路真的闭合：写 → 读 → 用')
{
  check('唤醒时把惦记记进 intentLoopTexts', /st\.intentLoopTexts\s*=\s*\(fresh\.length/.test(code))
  check('发送成功时消费它写进 purposeHistory', /st\.purposeHistory\.push/.test(code))
  check('消费后清空（否则会重复记）', /st\.intentLoopTexts\s*=\s*\[\]/.test(code))
  check('去重时读了 purposeHistory', /isDuplicateText\(l\.text, saidRecently/.test(code))
}

console.log('\n[7] 旧行为可完全退回（intent.enabled=false 时表现和改之前一样）')
{
  // 逻辑上：enabled=false → buildIntentLineV2 直接返回 ''，且唤醒文案是旧的那段吗？
  // 注意：我们**同时改了** proactiveCheck 的文案。文案改动不可回退，这要如实说明。
  const i = code.indexOf("if (reason === 'proactiveCheck')")
  const block = code.slice(i, i + 900)
  check('主动机会文案提到「惦记」（用上了新输入）', /你心里惦记着/.test(block), block.slice(0, 200))
  check('文案明说「不是任务」', /不是任务/.test(block) || /不开口也是正常/.test(block), block.slice(0, 260))
  check('保留了"安静收尾"的出口（不逼她说话）', /qq_mark_read|qq_set_wake_config/.test(block))
}

console.log('\n[8] 不该动的没被动：旧字段仍在保存清单里')
{
  for (const key of ['wakeConfig:', 'recentMessages:', 'unread:', 'activeTopics:', 'memberImpressions:', 'seenForwardIds:']) {
    check(`保存里仍有 ${key}`, code.includes(key))
  }
}

console.log('\n[9] 永久惦记刹车片（intentSeen）：落盘 + 只在真发出去之后 +1')
{
  check('保存里有 intentSeen', /intentSeen:\s*st\.intentSeen/.test(code), '重启后清零 = 刹车片失效')
  check('加载时有形状校验（脏数据不能进）', /intentSeen:\s*\(\(\)\s*=>/.test(code), '加载路径没校验')
  check('加载时挡了原型污染', /__proto__[\s\S]{0,200}intentSeen|intentSeen[\s\S]{0,400}__proto__/.test(code))
  check('初始化里有 intentSeen', /intentSeen:\s*\{\}/.test(code))
  check('计数只在发送成功后 +1', /st\.intentSeen\[loopText\]\s*=\s*\{[\s\S]{0,80}count:/.test(code))
  check('有上限（不能无限增长）', /slice\(0,\s*50\)/.test(code), 'Object 会无限长')
  check('collectOpenLoops 收到了 seenLoops', /seenLoops:\s*st\.intentSeen/.test(code),
    '不传的话降权逻辑永远空转')
}

console.log('\n[10] 驱动推进：只能有一处写回，且三条回合结束路径都要推进')
{
  // ⚠ 写回点只能有一处（advanceDrivesV2 里）。多的那处就是"重复推高"的来源。
  const writes = (code.match(/st\.drives\s*=\s*normalizeDrives/g) || []).length
  check('写回点只有一处（advanceDrivesV2）', writes === 1, `实际 ${writes} 处`)
  check('读路径不写回', !/st\.drives\s*=\s*derived\.drives/.test(code), '读的时候写回 = 每次调用推进一步')

  const i = code.indexOf('function advanceDrivesV2')
  check('推进函数存在', i > 0)
  const body = code.slice(i, i + 900).replace(/\/\/[^\n]*/g, '')
  check('有最小间隔保护（一分钟内不重复推进）', /60\s*\*\s*1000/.test(body), '没有节流会搅乱衰减周期')
  check('推进用的是暂存值', /intentNextDrives/.test(body))

  // 三条回合结束路径：说话了 / 沉默看完了 / 自然收尾了。
  // ⚠ 检查要**双向**（advance 可能写在日志行之前，也可能之后）。
  for (const [name, marker] of [
    ['发送成功', '工具统一发送'],
    ['mark_read（沉默看完）', "'/api/socialV2/mark-read'"],
    ['close_conversation（自然收尾）', "'/api/socialV2/close-conversation'"],
  ]) {
    const idx = code.indexOf(marker)
    const near = idx > 0 && /advanceDrivesV2/.test(code.slice(Math.max(0, idx - 3000), idx + 3000))
    check(`${name} 也会推进驱动`, near, '不推进的话，她连续沉默时衰减永远不跑')
  }

  // ⚠ 2026-10-29 自检抓出来的真 bug：推进曾经要求"这一回合算过驱动"，
  // 而 buildIntentLineV2 只在 proactiveCheck 跑 —— 于是她正常对话时衰减根本不推进。
  // 实测 drivesAt 停在 21:25 达 4.5 小时，而她在 01:03 还说过话（衰减慢了 20 倍）。
  const advBody = code.slice(code.indexOf('function advanceDrivesV2')).slice(0, 1400).replace(/\/\/[^\n]*/g, '')
  check('没有"没算过就不推进"的早退',
    !/if\s*\(!st\.intentNextDrives\)\s*return\s*false/.test(advBody),
    '这个早退会让衰减只在 proactiveCheck 才跑')
  check('没有暂存值时会补算衰减', /deriveDrives\(\{/.test(advBody) || /decayed/.test(advBody))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
