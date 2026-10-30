// 收尾机制接进桥之后的自检（读源码断言，不联网、不动真实 state/）。
// 用法：node test-closure-integration.mjs
//
// 这里测「接进去之后有没有把别的东西弄坏」，以及那些最容易漏的接线：
//   · 接口存在、能关、有硬闸
//   · close **不能**走沉睡前观察（那是 mark_read 的语义，混了就变成潜水）
//   · close **不能**改 wakeConfig（否则对方再找也叫不醒）
//   · 冷却只压软唤醒，被 @/提问 照常
//   · 记录必须落盘（否则下次醒来不知道上次收在哪）
//   · 对方开口要标记重开（否则复读上次结尾）
import fs from 'node:fs'

const code = fs.readFileSync(new URL('./src/bridge.js', import.meta.url), 'utf8')
const mcp = fs.readFileSync(new URL('./src/mcp-snowluma-safe.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

/** 取出某个函数的函数体（大括号配平；会剥掉行注释）。 */
function fnBody(src, signature) {
  const i = src.indexOf(signature)
  if (i < 0) return ''
  let depth = 0; let started = false; let end = i
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '{') { depth += 1; started = true }
    else if (src[k] === '}') { depth -= 1; if (started && depth === 0) { end = k; break } }
  }
  return src.slice(i, end)
}

console.log('\n[1] MCP 工具：定义 + 开关 + 映射三处都得登')
{
  check('工具定义存在', mcp.includes("'qq_close_conversation'"), '找不到工具定义')
  check('工具开关表里有 closeConversation', /qq_close_conversation:\s*'closeConversation'/.test(mcp))
  check('参数有 summary（留痕）', /summary:/ .test(mcp))
  check('参数有 nextOpening（下次接法）', /nextOpening:/.test(mcp))
  check('参数有 reason 枚举', /reason:\s*z\.enum\(/.test(mcp))
  check('工具说明里明说"不是潜水"', /不是潜水|不算潜水/.test(mcp), '模型会误以为是潜水')
  check('桥侧开关表（两处）都有 closeConversation',
    (code.match(/closeConversation:\s*true/g) || []).length === 2,
    `实际 ${(code.match(/closeConversation:\s*true/g) || []).length} 处`)
  check('桥侧工具名映射存在', /closeConversation:\s*'qq_close_conversation'/.test(code))
}

console.log('\n[2] 接口语义：close ≠ 潜水（最容易混的地方）')
{
  const i = code.indexOf("url.pathname === '/api/socialV2/close-conversation'")
  check('接口存在', i > 0)
  // 用**真实边界**（下一个 endpoint）截取，不要写死字符数 —— 写死会越界抓到别的接口的代码。
  const nextIdx = code.indexOf("url.pathname === '/api/socialV2/wake-config'", i + 10)
  const rawSeg = nextIdx > i ? code.slice(i, nextIdx) : code.slice(i, i + 4200)
  // ⚠ 必须剥掉注释再断言：注释里写着"刻意不做 preSleepWaitBlockedV2"，
  // 不剥就会把这句话本身当成"做了"（这个假失败被抓到过一次）。
  const seg = rawSeg.replace(/\/\/[^\n]*/g, '')
  check('有 token 校验', /agentTokenOk/.test(seg))
  check('有会话范围校验', /v2SessionAllowed/.test(seg))
  check('有工具开关校验', /v2ToolEnabled\('closeConversation'\)/.test(seg))
  check('有硬闸（closeGate）', /closeGate\(/.test(seg))
  check('被硬闸拦时返回 409（不是 500）', /\},\s*409\)/.test(seg), '应返回 409 让模型看懂')
  check('**不走**沉睡前观察', !/preSleepWaitBlockedV2/.test(seg), '走了就变成潜水语义')
  check('**不改** wakeConfig.mode/infinite/sleepUntil', !/wakeConfig\.(mode|infinite|sleepUntil)\s*=/.test(seg),
    '改了唤醒配置 = 对方再找也叫不醒')
  check('取消回复检查（别自己叫醒自己）', /cancelReplyCheckV2/.test(seg))
  check('保证至少有一条唤醒路', /ensureWakeableV2/.test(seg))
  check('记了 confirmedBy=close_conversation', /confirmedBy\s*=\s*'close_conversation'/.test(seg))
  check('返回体说明唤醒配置没变', /wakeConfigUnchanged/.test(seg))
}

console.log('\n[3] 判断逻辑接线：只在有对话时注入，异常不拖垮唤醒')
{
  const body = fnBody(code, 'function closurePromptLineV2')
  check('函数存在', body.length > 0)
  check('配置关了就不注入', /if\s*\(!c\.enabled\s*\|\|\s*!c\.promptInWake\)\s*return\s*''/.test(body))
  check('有 try/catch', /try\s*\{/.test(body) && /catch/.test(body))
  check('catch 返回空串而不是抛', /catch[\s\S]{0,200}return\s*''/.test(body))
  check('拼进 base', /\+\s*closureLine\b/.test(code.split('\n').find((l) => l.includes('const base = roleLine')) ?? ''))
  check('在 intentLine 之前（先判断该不该停）',
    (() => {
      const l = code.split('\n').find((x) => x.includes('const base = roleLine')) ?? ''
      return l.indexOf('closureLine') > 0 && l.indexOf('closureLine') < l.indexOf('intentLine')
    })())
}

console.log('\n[4] 冷却：压软唤醒，不压被叫到')
{
  const rb = fnBody(code, 'function scheduleReplyCheckV2')
  check('回复检查被冷却拦住', /closureSuppressesWake\(st\.closure, 'replyCheck'/.test(rb))
  const pb = fnBody(code, 'function scheduleProactiveCheckV2')
  check('主动机会被冷却拦住', /closureSuppressesWake\(st\.closure, 'proactiveCheck'/.test(pb))
  // 概率唤醒在 tick 里
  check('概率唤醒也拦了（或在 closureSuppressesWake 的白名单里）',
    /SOFT_WAKE_REASONS/.test(fs.readFileSync(new URL('./src/closure-engine.mjs', import.meta.url), 'utf8')))
  check('@/提问/拍一拍 不在白名单里',
    !/SOFT_WAKE_REASONS\s*=\s*new Set\(\[[^\]]*(atMention|question|poke)/.test(
      fs.readFileSync(new URL('./src/closure-engine.mjs', import.meta.url), 'utf8')))
}

console.log('\n[5] 状态落盘：记录不丢、脏数据不进')
{
  check('保存里有 closure', /closure:\s*st\.closure/.test(code))
  check('加载时有归一化', /closure:\s*normalizeClosureRecord\(val\.closure/.test(code),
    '脏数据会让唤醒挂掉')
  check('初始化有 closure: null', /closure:\s*null/.test(code))
  check('默认配置块存在', /closure:\s*\{/.test(code))
  check('默认配置有 enabled 开关', /closure:\s*\{[\s\S]{0,400}enabled:\s*true/.test(code))
  check('默认配置有 cooldownMs', /cooldownMs:\s*20\s*\*\s*60\s*\*\s*1000/.test(code),
    '没有冷却就等于不生效')
}

console.log('\n[6] 重开：对方开口要把上次收尾标成已重开')
{
  const body = fnBody(code, 'function appendSocialV2Message')
  check('新消息进来会 reopenClosure', /reopenClosure\(/.test(body), '不标就会复读上次结尾')
  check('保留原记录（只标 reopenedAt）', /st\.closure\s*=\s*reopenClosure/.test(body))
}

console.log('\n[7] 不该动的没被动')
{
  for (const k of ['qq_mark_read', 'qq_set_wake_config', 'qq_send_message']) {
    check(`老工具 ${k} 仍在`, mcp.includes(k))
  }
  check('mark_read 的沉睡前观察**没被**改掉', /preSleepWaitBlockedV2/.test(code),
    '那是 mark_read 的既有保护，不能顺手删')
  check('接口清单里 close-conversation 只注册一次',
    (code.match(/url\.pathname === '\/api\/socialV2\/close-conversation'/g) || []).length === 1)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
