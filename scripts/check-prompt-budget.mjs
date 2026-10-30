// 实测一次唤醒提示词的实际长度构成（只读，不启动桥）。
// 直接调纯函数，看各段占多少字。
import fs from 'node:fs'
import { formatCovenantBlock, covenantInjectConfig } from '../src/covenant-inject.mjs'
import { CovenantStore, localDay } from '../src/covenant-store.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
const store = new CovenantStore(new URL('../state/archive.db', import.meta.url).pathname.replace(/^\//, ''))

const covenant = formatCovenantBlock({
  store, key: 'private:<OWNER_QQ>', today: localDay(),
  config: covenantInjectConfig(cfg?.socialV2?.covenant),
})
store.close()

console.log('=== 契阔段实测 ===')
console.log('字数:', [...covenant].length)
console.log('占 wakeMaxChars(6000) 的:', (( [...covenant].length / 6000) * 100).toFixed(1) + '%')
console.log()

// 其他段的大致规模（从源码里的固定文案估）
const estimates = [
  ['roleLine（当前角色）', 40],
  ['identityLine（身份）', 120],
  ['tokenLine（会话令牌）', 80],
  ['antiAiLine（反AI味）', 80],
  ['proactiveLine（积极性）', 110],
  ['stickerLine（表情包）', 600],
  ['replyLine（首回复节奏）', 250],
  ['statusLine（此刻状态）', 200],
  ['wakeLine（当前唤醒）', 100],
  ['memoryLine（轻量记忆）', 0],
  ['recallLine（以前聊过）', 200],
  ['covenantLine（契阔）', [...covenant].length],
  ['biliLine（B站视频）', 0],
  ['participationLine（参与度）', 150],
  ['preSleepLine（沉睡前等待）', 300],
  ['timeSenseLine（时间感）', 100],
  ['closureLine（收尾判断）', 350],
  ['intentLine（惦记）', 130],
]
console.log('=== 各段估算（固定文案 + 实测）===')
console.log('段名'.padEnd(28), '字数')
let total = 0
for (const [name, n] of estimates) {
  console.log(name.padEnd(26), String(n).padStart(5))
  total += n
}
console.log('─'.repeat(36))
console.log('合计'.padEnd(26), String(total).padStart(5))
console.log()
console.log('wakeMaxChars 预算: 6000')
console.log(`占用 ${((total / 6000) * 100).toFixed(0)}%`, total > 6000 ? '← **已超预算**' : '')
console.log()
console.log('注意：这些是估算，粘性段（sticker/closure/intent）随内容变化。')
