// 对话收尾判断回归（纯函数，不联网、不改 state/）。
// 用法：node test-closure.mjs
//
// 测什么（这些是"每句话都要回"的成因）：
//   · 对方道别了还不让收尾 = 浪费时间
//   · 对方在提问却批准收尾 = 逃避（这条是硬闸，最重要）
//   · 纯附和「嗯」之后该能停，而不是必须再补一句
//   · 群聊半小时没人接该算散场，私聊不该（对方可能只是忙）
//   · 收尾要留痕：summary / nextOpening 落盘，否则下次只能重新开场
//   · 冷却只压软唤醒，不能压被叫到
import {
  DEFAULT_CLOSURE_CONFIG, normalizeClosureConfig, classifyMessage,
  assessConversationClosure, closurePromptBlock, makeClosureRecord,
  normalizeClosureRecord, closureSuppressesWake, reopenClosure, closeGate,
  closureStatus, formatClosureRecord,
} from './src/closure-engine.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const MIN = 60 * 1000
const now = Date.now()
const msg = (text, { self = false, time = now, media = [], quoteSelf = false } = {}) => ({
  text, plain: text, isSelf: self, time, media, quoteTargetIsSelf: quoteSelf,
})
// 按时序拼一段对话：others/self 交替
const convo = (pairs, { base = now, gapMin = 1 } = {}) => pairs.map(([who, t], i) => ({
  text: t, plain: t, isSelf: who === 'self', time: base - (pairs.length - i) * gapMin * MIN, media: [],
}))

console.log('\n[1] 消息分类：五类要分得准')
{
  check('「晚安」→ ending', classifyMessage('晚安').kind === 'ending')
  check('「先这样」→ ending', classifyMessage('先这样').kind === 'ending')
  check('「在吗？」→ question', classifyMessage('在吗？').kind === 'question')
  check('「装好了没」→ question（末尾"没"）', classifyMessage('装好了没').kind === 'question',
    classifyMessage('装好了没').kind)
  check('「帮我看看」→ request', classifyMessage('帮我看看这个').kind === 'request')
  check('「嗯」→ ack', classifyMessage('嗯').kind === 'ack')
  check('「哈哈」→ ack', classifyMessage('哈哈').kind === 'ack')
  check('有实际内容 → substantive', classifyMessage('今天加班到十点').kind === 'substantive')
  check('空文本 + 图片 → substantive（不是 silence）',
    classifyMessage({ text: '', media: [{}] }).kind === 'substantive')
  check('「说好了」带 settled 标记', classifyMessage('那就说好了').settled === true)
  check('标记引用自己的消息', classifyMessage({ text: '嗯', quoteTargetIsSelf: true }).quoteSelf === true)
}

console.log('\n[2] 对方道别 → 该批准收尾')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['other', '我先睡了'], ['self', '嗯嗯']]),
    now,
  })
  check('verdict=close', a.verdict === 'close', JSON.stringify(a.verdict) + ' ' + a.reasons.join('/'))
  check('说明了原因（对方道别）', a.reasons.some((r) => /道别/.test(r)), a.reasons.join('/'))
  check('有 advice 给人看', /收尾/.test(a.advice), a.advice)
}

console.log('\n[3] 对方在提问 → 必须阻止收尾（硬闸，最重要）')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['self', '我看看'], ['other', '装好了没']]),
    now,
  })
  check('verdict=continue', a.verdict === 'continue', a.verdict)
  check('awaitingTheirAnswer=true', a.signals.awaitingTheirAnswer === true)
  check('reasons 点明了未答提问', a.reasons.some((r) => /没答|提问/.test(r)), a.reasons.join('/'))
  check('advice 明确"先回答"', /先回答/.test(a.advice), a.advice)

  const gate = closeGate(a)
  check('closeGate 拦住了', gate.blocked === true, JSON.stringify(gate))
  check('拦截原因可读', /提问|求助/.test(String(gate.error)), String(gate.error))
}

console.log('\n[4] 纯附和「嗯」之后：可以停，不必再补一句')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['other', '我在忙'], ['self', '好'], ['other', '嗯']]),
    now,
  })
  check('对方只回了「嗯」时不该判 continue', a.verdict !== 'continue', `${a.verdict} score=${a.score}`)
  check('topicClosure 偏高（附和=画句号）', a.signals.topicClosure >= 0.6, String(a.signals.topicClosure))
  check('theirIntent 很低（对方没在追）', a.signals.theirIntent < 0.3, String(a.signals.theirIntent))
}

console.log('\n[5] 我这边还有想说没说的 → 别急着收')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['other', '嗯'], ['self', '好']]),
    pendingThoughts: [{ text: '其实我还想说那个视频的事' }],
    now,
  })
  check('ownIntent 被 thought 抬高', a.signals.ownIntent >= 0.3, String(a.signals.ownIntent))
  check('verdict 不是 close', a.verdict !== 'close', a.verdict)
  check('reasons 提到想说没说的', a.reasons.some((r) => /想说没说/.test(r)), a.reasons.join('/'))
}

console.log('\n[6] 群聊散了 vs 私聊还在忙（场景不同判据不同）')
{
  const old = now - 45 * MIN
  const groupMsgs = [msg('今天好累', { time: old }), msg('嗯', { time: old + MIN })]
  const g = assessConversationClosure({ kind: 'group', messages: groupMsgs, now })
  check('群聊 45 分钟没人接 → close', g.verdict === 'close', `${g.verdict}`)

  const p = assessConversationClosure({ kind: 'private', messages: groupMsgs, now })
  check('私聊同样情况**不**判 close（对方可能只是忙）', p.verdict !== 'close', p.verdict)
}

console.log('\n[7] 对方明显还想继续 → 不判收尾')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['self', '嗯'], ['other', '我今天遇到个特别离谱的事']]),
    now,
  })
  check('verdict 不是 close', a.verdict !== 'close', a.verdict)
  check('theirIntent 高', a.signals.theirIntent >= 0.5, String(a.signals.theirIntent))
}

console.log('\n[8] 提示词块：有对话才产出，说清参数不代替决定')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['other', '我先睡了'], ['self', '晚安']]),
    now,
  })
  const block = closurePromptBlock(a)
  check('有内容', block.includes('【对话收尾判断】'), block.slice(0, 60))
  check('写了对方/自己最后一句是什么', /对方最后一句/.test(block) && /我最后一句/.test(block))
  check('给了参数（意愿/闭环/疲劳）', /继续意愿/.test(block) && /话题闭环/.test(block))
  check('提到 qq_close_conversation', block.includes('qq_close_conversation'))
  check('明说不是潜水', /不是潜水/.test(block))
  check('明说别每轮都收尾', /不要每轮都收尾/.test(block))

  const empty = assessConversationClosure({ kind: 'private', messages: [], now })
  check('没有对话 → 空串（不白烧 token）', closurePromptBlock(empty) === '', JSON.stringify(closurePromptBlock(empty)))
}

console.log('\n[9] 收尾记录：留痕 + 上限 + 脏数据')
{
  const a = assessConversationClosure({
    kind: 'private',
    messages: convo([['other', '晚安']]),
    now,
  })
  const rec = makeClosureRecord({
    key: 'private:1', kind: 'private', assessment: a,
    body: { reason: 'explicit-end', summary: '他说要去睡了', nextOpening: '明天问他睡够了没' },
    now,
  })
  check('reason 保留', rec.reason === 'explicit-end', rec.reason)
  check('summary 落盘', rec.summary === '他说要去睡了', rec.summary)
  check('nextOpening 落盘', rec.nextOpening === '明天问他睡够了没')
  check('冷却时间设置', rec.cooldownUntil > now)

  const longRec = makeClosureRecord({
    key: 'private:1', assessment: a,
    body: { summary: '一'.repeat(400) }, now,
  })
  check('summary 超长被截断', [...longRec.summary].length <= 161, String([...longRec.summary].length))

  const bad = normalizeClosureRecord({ at: 'x' })
  check('坏记录 → null', bad === null)
  const ok = normalizeClosureRecord({ at: now, reason: 'unknown-thing', summary: 'x' })
  check('未知 reason 回 natural', ok.reason === 'natural', ok.reason)
  check('缺 cooldownUntil 时按配置补', ok.cooldownUntil > ok.at)

  const text1 = formatClosureRecord(rec, now)
  check('格式化含"上次这段"', /上次这段/.test(text1), text1)
  check('格式化含 summary', text1.includes('他说要去睡了'))
  check('格式化含下次接法', text1.includes('明天问他睡够了没'))
  const st = closureStatus(rec, now)
  check('status 摘要可用', st && st.cooldownActive === true, JSON.stringify(st))
}

console.log('\n[10] 软冷却：只压能忍的，不压被叫到')
{
  const rec = { cooldownUntil: now + 10 * MIN }
  check('概率唤醒被压', closureSuppressesWake(rec, 'probability', now) === true)
  check('回复检查被压', closureSuppressesWake(rec, 'replyCheck', now) === true)
  check('主动机会被压', closureSuppressesWake(rec, 'proactiveCheck', now) === true)
  check('被 @ **不**被压', closureSuppressesWake(rec, 'atMention@seq5', now) === false)
  check('提问唤醒 **不** 被压', closureSuppressesWake(rec, 'question', now) === false)
  check('拍一拍 **不** 被压', closureSuppressesWake(rec, 'poke', now) === false)
  check('冷却过期后不压', closureSuppressesWake(rec, 'probability', now + 11 * MIN) === false)
  check('没有记录不压', closureSuppressesWake(null, 'probability', now) === false)
}

console.log('\n[11] 重开：对方又开口，是新开始不是复读')
{
  const rec = { at: now - 5 * MIN, summary: '他说要睡了' }
  const re = reopenClosure(rec, { now })
  check('标记了 reopenedAt', re.reopenedAt === now)
  check('原记录保留（summary 不丢）', re.summary === '他说要睡了')
  const again = reopenClosure(re, { now: now + 10 * 1000 })
  check('短时间内重复重开不刷新', again.reopenedAt === now)

  // ⚠ 自检抓出来的漏洞：重开后冷却必须立即失效。
  // 原来只标 reopenedAt、冷却照旧压着软唤醒 ——
  // 对方收尾后又开新话题，她可能因冷却不醒，变成"已读不回"。
  const cooling = { at: now - MIN, cooldownUntil: now + 19 * MIN }
  check('未重开时冷却生效', closureSuppressesWake(cooling, 'replyCheck', now) === true)
  const reopenedCooling = reopenClosure(cooling, { now })
  check('重开后冷却**立即失效**', closureSuppressesWake(reopenedCooling, 'replyCheck', now) === false,
    '不失效就会变成"别人叫也不应"')
  check('重开后主动机会也不再被压', closureSuppressesWake(reopenedCooling, 'proactiveCheck', now) === false)

  const a = assessConversationClosure({ kind: 'private', messages: convo([['other', '我又回来了']]), now })
  const blk = closurePromptBlock(a, { record: re, now })
  check('提示词说明"这是新的开始"', /新的开始/.test(blk), blk.slice(-160))
  check('提示词说别复读上次结尾', /别复读/.test(blk))
}

console.log('\n[12] 配置：能关、边界夹紧')
{
  check('默认开', normalizeClosureConfig({}).enabled === true)
  check('能关掉', normalizeClosureConfig({ enabled: false }).enabled === false)
  check('关掉时 closeGate 拦住', closeGate(null, { enabled: false }).blocked === true)
  check('requireNoOpenQuestion=false 时放过提问', (() => {
    const a = { signals: { awaitingTheirAnswer: true } }
    return closeGate(a, { requireNoOpenQuestion: false }).blocked === false
  })())
  check('cooldownMs 超出上限被夹', normalizeClosureConfig({ cooldownMs: 999 * 24 * 60 * MIN }).cooldownMs <= 24 * 60 * MIN)
  check('windowMs 下限被夹', normalizeClosureConfig({ windowMs: 1 }).windowMs >= 5 * MIN)
  check('坏配置不抛', (() => { try { normalizeClosureConfig('nope'); return true } catch { return false } })())
}

console.log('\n[13] 稳健性：坏输入不抛')
{
  const cases = [
    () => assessConversationClosure({}),
    () => assessConversationClosure({ messages: 'x' }),
    () => assessConversationClosure({ messages: [null, undefined, {}, { time: 'x' }] }),
    () => classifyMessage(null), () => classifyMessage({ }),
    () => closurePromptBlock(null), () => closeGate(undefined),
    () => normalizeClosureRecord(null), () => formatClosureRecord(null),
    () => closureStatus(null), () => reopenClosure(null),
  ]
  let threw = ''
  for (const fn of cases) { try { fn() } catch (e) { threw = e.message } }
  check('全部不抛', threw === '', threw)
}

console.log('\n[14] 没有进行中的对话，但有收尾记录 → 记录仍要注入（留痕的意义）')
{
  const empty = assessConversationClosure({ kind: 'private', messages: [], now })
  const rec = makeClosureRecord({
    key: 'private:1', kind: 'private', assessment: empty,
    body: { summary: '他说要睡了', nextOpening: '明天问他睡够了没' }, now: now - 5 * MIN,
  })

  check('无对话无记录 → 空串', closurePromptBlock(empty) === '')
  const blk = closurePromptBlock(empty, { record: rec, now })
  check('无对话但有记录 → 不空（这是留痕的全部意义）', blk.length > 0, JSON.stringify(blk))
  check('给出了「上次这段聊到哪」', /上次这段聊到哪/.test(blk), blk.slice(0, 80))
  check('带上 summary', blk.includes('他说要睡了'), blk)
  check('带上 nextOpening', blk.includes('明天问他睡够了没'), blk)
  check('说明了这是过去的结束点（别假装记得）', /不是现在正在聊的内容/.test(blk))
  check('**不给**收尾判断（没有可判断的对话）', !/【对话收尾判断】/.test(blk), blk.slice(0, 80))

  const withConvo = assessConversationClosure({
    kind: 'private', messages: convo([['other', '嗯']]), now,
  })
  const both = closurePromptBlock(withConvo, { record: rec, now })
  check('有对话时判断块还在', /【对话收尾判断】/.test(both))
  check('有对话时记录也在', both.includes('他说要睡了'), both.slice(-120))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
