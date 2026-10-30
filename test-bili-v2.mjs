// 二代仿真（reserved2）B 站链路回归。
//
// 为什么单独有这个文件：test-all-bili.mjs 只测「取数」（buildVideoContext 单独跑），
// 而 2026-10-27 12:22 真正出问题的地方不在取数，在**投递**——reserved2 的消息在
// handleIncoming 里就 return 了，一代那条 buildBiliVideoBlock 根本没被调用过，
// 所以她的上下文里只有一行「[卡片消息] 标题 https://b23.tv/xxx」。
//
// 这个文件不联网、不起桥接：把桥接里那套 pending/peek/consume/子目录逻辑
// 按同样的形状重建一遍，验证语义——包括「投递被拒不能落账」和「两条视频不串图」。
//
// 用法：node test-bili-v2.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-v2-'))
const BILI_DIR = path.join(TMP, 'media-tmp', 'bili')
const STATE = { lastBiliDeliveredSeq: 0 }

// ── 桥接里那套逻辑的最小复刻 ────────────────────────────────────────────────
const pendingBiliV2 = new Map()
function bounded(list) { if (list.length > 3) list.splice(0, list.length - 3) }
function prepare(key, seq, block, files) {
  let list = pendingBiliV2.get(key)
  if (!list) { list = []; pendingBiliV2.set(key, list) }
  list.push({ seq, block, files })
  bounded(list)
}
function peek(key, st) {
  const list = pendingBiliV2.get(key)
  if (!Array.isArray(list) || !list.length) return { text: '', files: [] }
  const blocks = []; const files = []
  for (const item of list) {
    if (!item || typeof item.seq !== 'number') continue
    if (item.seq <= (st.lastBiliDeliveredSeq || 0)) continue
    blocks.push(item.block)
    for (const f of item.files ?? []) if (!files.includes(f)) files.push(f)
  }
  return blocks.length ? { text: `${blocks.join('\n\n')}\n\n`, files } : { text: '', files: [] }
}
function consume(key, st) {
  const list = pendingBiliV2.get(key)
  if (!Array.isArray(list) || !list.length) return
  let max = st.lastBiliDeliveredSeq || 0
  for (const i of list) if (i && typeof i.seq === 'number' && i.seq > max) max = i.seq
  st.lastBiliDeliveredSeq = max
  pendingBiliV2.delete(key)
}
// 每条视频一个子目录；成品名固定，所以不隔离就会互相覆盖
function videoDir() {
  const d = path.join(BILI_DIR, `${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function putTile(d, content) {
  const f = path.join(d, 'sb-tile.jpg')
  fs.writeFileSync(f, content)
  return f
}

console.log('\n[1] 待投递 → peek 不改状态（被跳过的那一轮不能丢图）')
const KEY = 'private:<OWNER_QQ>'
const d1 = videoDir()
const f1 = putTile(d1, Buffer.from('video-one-frame'))
prepare(KEY, 10, '【视频A】标题A\n画面：故事板 6 帧', [f1])

const first = peek(KEY, STATE)
check('第一次 peek 拿到视频段', /视频A/.test(first.text), first.text.slice(0, 40))
check('第一次 peek 拿到拼图', first.files.includes(f1), JSON.stringify(first.files))
const second = peek(KEY, STATE)
check('再 peek 一次内容不变（没有提前落账）', /视频A/.test(second.text) && second.files.includes(f1))
check('STATE 未被 peek 改动', STATE.lastBiliDeliveredSeq === 0, String(STATE.lastBiliDeliveredSeq))

console.log('\n[2] 投递成功后才落账，且老视频不再重复注入')
consume(KEY, STATE)
check('落账水位推进到 seq 10', STATE.lastBiliDeliveredSeq === 10, String(STATE.lastBiliDeliveredSeq))
check('内存里已清空', !pendingBiliV2.has(KEY))
const afterConsume = peek(KEY, STATE)
check('再次 peek 为空（不会重放已给过的画面）', afterConsume.text === '' && afterConsume.files.length === 0)

console.log('\n[3] 两条视频不串图（固定文件名 + 共用目录时必踩）')
const d2 = videoDir()
const d3 = videoDir()
const f2 = putTile(d2, Buffer.from('video-two-frame'))
const f3 = putTile(d3, Buffer.from('video-three-frame'))
check('两条视频落在不同子目录', path.dirname(f2) !== path.dirname(f3))
check('各自字节没被覆盖', fs.readFileSync(f2, 'utf8') === 'video-two-frame' && fs.readFileSync(f3, 'utf8') === 'video-three-frame')
prepare(KEY, 11, '【视频B】标题B', [f2])
prepare(KEY, 12, '【视频C】标题C', [f3])
const both = peek(KEY, STATE)
check('两段都在 prompt 里', /标题B/.test(both.text) && /标题C/.test(both.text))
check('两张拼图都在投递部件里（顺序保持）', both.files.length === 2 && both.files[0] === f2 && both.files[1] === f3)

console.log('\n[4] 有界：最多排 3 条，不会无限涨')
for (let i = 0; i < 6; i += 1) {
  const d = videoDir()
  prepare(KEY, 20 + i, `【视频${i}】`, [putTile(d, Buffer.from(`x${i}`))])
}
const list = pendingBiliV2.get(KEY)
check('队列被裁到 3 条', list.length === 3, String(list.length))
check('保留的是最新的三条', list.every((it) => it.seq >= 23), list.map((i) => i.seq).join(','))

console.log('\n[5] 已投递的不再拼进 prompt（水位过滤）')
STATE.lastBiliDeliveredSeq = 24
const filtered = pendingBiliV2.get(KEY).filter((i) => i.seq > STATE.lastBiliDeliveredSeq)
check('水位之后只剩 1 条', filtered.length === 1, String(filtered.length))
peek(KEY, { lastBiliDeliveredSeq: 24 })
check('peek 不因为水位截断而清空数据', pendingBiliV2.get(KEY).length === 3)

console.log('\n[6] 失败提示也算一条，但不带图')
const failState = { lastBiliDeliveredSeq: 25 } // 把前面那几条当作已投递，只看新增的失败条目
prepare(KEY, 30, '【他刚分享了一个视频，但没取到】\n原因：处于风控暂停，还需 12 分钟', [])
const failed = peek(KEY, failState)
check('失败原因进了 prompt', /没取到/.test(failed.text) && /风控暂停/.test(failed.text))
check('失败时不带任何图片', failed.files.length === 0, JSON.stringify(failed.files))
check('同一个 prompt 里只出现这一条（不夹带前面的老视频）', !/【视频[BC]】/.test(failed.text), failed.text.slice(0, 60))

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
