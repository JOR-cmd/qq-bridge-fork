// 目的引擎回归（不联网、不碰真实 state/、纯函数）。
// 用法：node test-intent.mjs
//
// 测什么（这些是"呆"的内容层成因）：
//   · 需求向量会不会随机乱跳（不能是掷骰子）
//   · 他多久没说话 → 想陪的需求该涨，不涨就是静态的假机制
//   · 人格卡里的"黏人/心软"该抬高地板，但不能盖过真实素材
//   · 未答的提问必须被识别为最高优先的"惦记"
//   · 素材太旧 / 噪声消息不该变成"惦记"
//   · 没有素材时不能产出没信息量的废话（契阔那次踩过的坑）
import {
  NEEDS, DEFAULT_DRIVES, normalizeDrives, needAffinity, analyzePersonaBias,
  deriveDrives, topNeeds, collectOpenLoops, textSimilarity, isDuplicateText,
  buildIntentBlock, describeIntentState, summarize, applyFamiliarity, familiarityFactor,
  withLoneliness, withJitter,
} from './src/intent-engine.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const HOUR = 60 * 60 * 1000
const noJitter = () => 0.5 // 抖动量恒为 0，测试结果可复现
const msg = (text, { self = false, time = Date.now(), sender = '' } = {}) => ({
  text, plain: text, isSelf: self, time, sender,
})

console.log('\n[1] 需求向量：基线 / 归一化 / 坏值')
{
  check('5 个维度', NEEDS.length === 5, String(NEEDS.length))
  check('基线都在 0~1', NEEDS.every((n) => DEFAULT_DRIVES[n] >= 0 && DEFAULT_DRIVES[n] <= 1))
  check('null 不抛、回默认', normalizeDrives(null).connect === DEFAULT_DRIVES.connect)
  check('超界值被夹到 1', normalizeDrives({ connect: 5 }).connect === 1)
  check('负值被夹到 0', normalizeDrives({ care: -3 }).care === 0)
  check('字符串数字能接受', normalizeDrives({ share: '0.5' }).share === 0.5)
}

console.log('\n[2] 文本 → 需求向量（不是关键词硬匹配，要有交叉增强）')
{
  const tired = needAffinity('今天好累，作业还剩一堆')
  check('「累/作业」命中关心', tired.care > 0, JSON.stringify(tired))
  const lonely = needAffinity('想你了，晚安')
  check('「想你/晚安」命中陪', lonely.connect > 0)
  const nothing = needAffinity('嗯')
  check('完全没命中时给 share 一点底（不是全 0）', nothing.share > 0, JSON.stringify(nothing))
  const both = needAffinity('你累了吧，我陪你')
  check('关心 + 陪 交叉增强（陪被抬高）', both.connect > 0.2, JSON.stringify(both))
}

console.log('\n[3] 人格卡 → 动机先验（surfcore 最值得抄的一条）')
{
  const clingy = analyzePersonaBias('很黏人，怕孤独，喜欢撒娇，心软')
  check('「黏人/撒娇/怕孤独」→ connect 有偏置', clingy.bias.connect > 0, JSON.stringify(clingy.bias))
  check('「心软」→ care 有偏置', clingy.bias.care > 0)
  check('偏置有上限（不能盖过素材）', Object.values(clingy.bias).every((v) => v <= 0.22), JSON.stringify(clingy.bias))
  const blank = analyzePersonaBias('')
  check('空人格卡 → 无偏置', Object.values(blank.bias).every((v) => v === 0))
  check('有 traits 可选用于调试', Array.isArray(clingy.traits))
}

console.log('\n[4] 驱动衰减 + 寂寞（读取时叠加，不写进状态）')
const DEFAULT_DRIVES_OBJ = { ...DEFAULT_DRIVES }
{
  // 刚聊完 → connect 不该暴涨
  const justTalked = deriveDrives({
    drives: { ...DEFAULT_DRIVES, connect: 0.9 },
    drivesAt: Date.now() - 1 * HOUR,
    lastMasterAt: Date.now() - 5 * 60 * 1000,
    now: Date.now(), random: noJitter,
  })
  check('刚聊完 connect 会衰减下来', justTalked.drives.connect < 0.9, String(justTalked.drives.connect))

  // 一天没说话 → connect 明显更高
  const lonely = deriveDrives({
    drives: { ...DEFAULT_DRIVES, connect: 0.3 },
    drivesAt: Date.now() - 8 * HOUR,
    lastMasterAt: Date.now() - 24 * HOUR,
    now: Date.now(), random: noJitter,
  })
  // ⚠ 2026-10-29：寂寞已经**移出** deriveDrives，改成读取时用 withLoneliness 叠加。
  // 原因：写进状态会累积（推两次就封顶），或矫枉过正（drivesAt 越新扣得越多）。
  // 所以这里改测 withLoneliness，deriveDrives 本身不再受 lastMasterAt 影响。
  const lonelyBase = deriveDrives({ ...DEFAULT_DRIVES_OBJ, drivesAt: Date.now() - 8 * HOUR, now: Date.now(), random: noJitter })
  const lonelyNow = withLoneliness(lonelyBase.drives, Date.now() - 24 * HOUR, Date.now())
  check('一天没说话 → connect 被 withLoneliness 抬高', lonelyNow.connect > 0.3, String(lonelyNow.connect))
  check('connect 不会超过 0.95', lonelyNow.connect <= 0.95, String(lonelyNow.connect))
  check('deriveDrives 本身不再叠加寂寞（写进状态会累积）',
    Math.abs(lonelyBase.drives.connect - DEFAULT_DRIVES_OBJ.connect) < 0.05,
    String(lonelyBase.drives.connect))

  // 半衰期检查：8 小时后应接近基线
  const decayed = deriveDrives({
    drives: { ...DEFAULT_DRIVES, share: 1 },
    drivesAt: Date.now() - 8 * HOUR,
    lastMasterAt: Date.now(), now: Date.now(), random: noJitter,
  })
  const mid = DEFAULT_DRIVES.share + (1 - DEFAULT_DRIVES.share) * 0.5
  check('8 小时 ≈ 半衰期', Math.abs(decayed.drives.share - mid) < 0.02,
    `got ${decayed.drives.share.toFixed(3)} want ${mid.toFixed(3)}`)
}

console.log('\n[5] 素材推高对应需求 + 人格地板不被每轮顶满')
{
  const base = deriveDrives({ drives: DEFAULT_DRIVES, drivesAt: Date.now(), lastMasterAt: Date.now(), now: Date.now(), random: noJitter })
  const withMats = deriveDrives({
    drives: DEFAULT_DRIVES, drivesAt: Date.now(), lastMasterAt: Date.now(),
    materials: [{ text: '今天好累，作业写不完' }, { text: '好累' }],
    now: Date.now(), random: noJitter,
  })
  check('看到「累」的素材 → care 被推高', withMats.drives.care > base.drives.care,
    `${withMats.drives.care.toFixed(3)} vs ${base.drives.care.toFixed(3)}`)

  // 人格地板反复应用不应无限累加。
  // ⚠ 用**固定时钟**：原来每轮都调 Date.now()，于是 lastMasterAt 与 now 相差几毫秒，
  //    跨分钟时抖动种子还会变 —— 实测偶发算出 0.92（应该是 0.50），害得这条时红时绿。
  const bias = { connect: 0.2 }
  const fixedNow5 = Math.floor(Date.now() / 60000) * 60000
  let d = DEFAULT_DRIVES
  for (let i = 0; i < 50; i += 1) {
    d = deriveDrives({
      drives: d, drivesAt: fixedNow5, lastMasterAt: fixedNow5,
      personaBias: bias, now: fixedNow5, random: noJitter,
    }).drives
  }
  check('50 轮后 connect 稳定在地板附近（不是累加到 1）', d.connect < 0.75, String(d.connect.toFixed(3)))
  // 再跑 50 轮，结果应当不再变化（真幂等）
  let d2 = d
  for (let i = 0; i < 50; i += 1) {
    d2 = deriveDrives({
      drives: d2, drivesAt: fixedNow5, lastMasterAt: fixedNow5,
      personaBias: bias, now: fixedNow5, random: noJitter,
    }).drives
  }
  check('再 50 轮结果不变（真幂等）', Math.abs(d2.connect - d.connect) < 1e-9,
    `${d.connect.toFixed(4)} vs ${d2.connect.toFixed(4)}`)

  // ⚠ 2026-10-29 自检抓出来的真 bug：抖动曾经写进状态，导致一轮轮累积到封顶。
  // 实测 100 轮后 connect 从 0.50 涨到 1.0000，连没有地板的 care 也从 0.2226 涨到 0.2328。
  // 现在抖动只在读取时叠（withJitter），绝不写回 —— 这条测试就是锁住这一点。
  const T = Math.floor(Date.now() / 60000) * 60000
  let d3 = DEFAULT_DRIVES
  for (let i = 0; i < 100; i += 1) {
    d3 = deriveDrives({ drives: d3, drivesAt: T, lastMasterAt: T, now: T, random: noJitter }).drives
  }
  check('100 轮后仍等于基线（抖动不再写进状态）',
    Math.abs(d3.connect - DEFAULT_DRIVES.connect) < 1e-9 && Math.abs(d3.care - DEFAULT_DRIVES.care) < 1e-9,
    `connect=${d3.connect.toFixed(4)} care=${d3.care.toFixed(4)}`)

  // withJitter 是读取层，同一分钟内稳定、不改入参
  const base4 = { ...DEFAULT_DRIVES }
  const j1 = withJitter(base4, { now: T })
  const j2 = withJitter(base4, { now: T })
  check('withJitter 同一分钟内稳定', Math.abs(j1.connect - j2.connect) < 1e-12)
  check('withJitter 不改入参', base4.connect === DEFAULT_DRIVES.connect)
  check('withJitter 偏离很小（只是手感，不是实质）', Math.abs(j1.connect - base4.connect) <= 0.011,
    String(Math.abs(j1.connect - base4.connect)))
}

console.log('\n[6] topNeeds：阈值过滤，低分不产出')
{
  const t = topNeeds({ connect: 0.5, care: 0.1, share: 0.05, curiosity: 0.05, play: 0.05 })
  check('低分被过滤掉', t.length === 1, JSON.stringify(t))
  check('返回 label 可直接进提示词', t[0].label === '陪', t[0].label)
  const none = topNeeds({ connect: 0.1, care: 0.1, share: 0.1, curiosity: 0.1, play: 0.1 })
  check('全低 → 空数组（不产出废话）', none.length === 0)
}

console.log('\n[7] 未闭合的事：未答的提问优先（这是"惦记"最硬的来源）')
{
  const now = Date.now()
  const msgs = [
    msg('帮我看看这个装好了没', { time: now - 30 * HOUR }),   // 问过、她没回
    msg('嗯', { self: true, time: now - 29 * HOUR }),
    msg('明天要考试了，得早点睡', { time: now - 20 * HOUR }), // 未来事件
    msg('草', { time: now - 3 * HOUR }),                       // 噪声
    msg('[图片]', { time: now - 2 * HOUR }),                   // 噪声
  ]
  const loops = collectOpenLoops({ messages: msgs, now })
  check('识别出未答提问', loops.some((l) => l.kind === 'unanswered'), JSON.stringify(loops.map((l) => l.kind)))
  check('owner 标注为他（不是我的）', loops.find((l) => l.kind === 'unanswered')?.owner === 'owner')
  check('噪声「草」「[图片]」不进来', !loops.some((l) => /^(草|\[图片\])$/.test(l.text)), JSON.stringify(loops.map((l) => l.text)))
  check('有 why 字段（可解释）', loops.every((l) => typeof l.why === 'string' && l.why.length > 0))
}

console.log('\n[8] 太旧的事不该变成"惦记"')
{
  const now = Date.now()
  const old = [
    msg('明天要考试了', { time: now - 10 * 24 * HOUR }),
    msg('你帮我看看这个', { time: now - 8 * 24 * HOUR }),
  ]
  const loops = collectOpenLoops({ messages: old, now, maxAgeMs: 72 * HOUR })
  check('超过 72 小时窗口的不进来', loops.length === 0, JSON.stringify(loops.map((l) => l.text)))
}

console.log('\n[9] 已经回过的问题不再算"未答"')
{
  const now = Date.now()
  const msgs = [
    msg('这个怎么弄？', { time: now - 5 * HOUR }),
    msg('这样弄就行', { self: true, time: now - 4 * HOUR }),
  ]
  const loops = collectOpenLoops({ messages: msgs, now })
  check('回过了就不算未答', !loops.some((l) => l.kind === 'unanswered'), JSON.stringify(loops.map((l) => l.kind)))
}

console.log('\n[10] 相似度去重（避免重复主动说同一件）')
{
  check('完全相同 → 1', textSimilarity('你好呀', '你好呀') === 1)
  check('完全不同 → 低分', textSimilarity('今天好累', '服务器崩了') < 0.2, String(textSimilarity('今天好累', '服务器崩了')))
  check('近似但不完全相同 → 高分', textSimilarity('你作业写完了吗', '你作业写完了没') > 0.5,
    String(textSimilarity('你作业写完了吗', '你作业写完了没')))
  const hist = [{ text: '你作业写完了吗' }]
  check('命中历史 → 判重', isDuplicateText('你作业写完了没', hist) === true)
  check('没命中 → 不判重', isDuplicateText('今天天气不错', hist) === false)
  check('空历史不炸', isDuplicateText('x', []) === false)
}

console.log('\n[11] buildIntentBlock：有素材才产出，没素材不废话')
{
  const none = buildIntentBlock({ drives: { connect: 0.1, care: 0.1, share: 0.1, curiosity: 0.1, play: 0.1 }, loops: [] })
  check('无素材无倾向 → 空串（不产出废话）', none === '', JSON.stringify(none))

  const withLoop = buildIntentBlock({
    drives: { connect: 0.6, care: 0.2, share: 0.1, curiosity: 0.1, play: 0.1 },
    loops: [{ owner: 'owner', kind: 'unanswered', text: '帮我看看装好了没', ageMs: 30 * HOUR, why: '他问过' }],
  })
  check('有素材 → 产出块', withLoop.includes('【你心里惦记着】'), withLoop.slice(0, 80))
  check('写了那件事本身', withLoop.includes('帮我看看装好了没'))
  check('写了多久之前（时间感）', /小时前|天前/.test(withLoop))
  check('明说「不是任务清单」', withLoop.includes('不是任务') , withLoop)

  const onlyDrive = buildIntentBlock({ drives: { connect: 0.7, care: 0.2, share: 0.1, curiosity: 0.1, play: 0.1 }, loops: [] })
  check('只有倾向也能产出（不说废话的前提下）', onlyDrive.includes('【此刻偏向】'), onlyDrive.slice(0, 80))
  check('倾向被翻译成一句"想做什么"', onlyDrive.includes('想找他说话') || onlyDrive.includes('想'), onlyDrive)

  const selfLoop = buildIntentBlock({ drives: { connect: 0.3, care: 0.3, share: 0.3, curiosity: 0.3, play: 0.3 }, loops: [{ owner: 'self', kind: 'promised', text: '等我看完那个视频', ageMs: 2 * HOUR }] })
  check('owner=self 不加「他」的标签', !selfLoop.includes('[他]'), selfLoop.slice(0, 120))
}

console.log('\n[12] summarize / describeIntentState（进提示词前的压缩）')
{
  check('长句被截断并带省略号', summarize('一'.repeat(100)).endsWith('…'))
  check('短句原样返回', summarize('你好') === '你好')
  check('表情包占位被剥掉', summarize('[表情] 好啊') === '好啊')
  const d = describeIntentState({ connect: 0.5, care: 0.3, share: 0.1, curiosity: 0.1, play: 0.1 })
  check('诊断串可读', /陪:0\.5/.test(d), d)
}

console.log('\n[13] 稳健性：坏输入不抛')
{
  const cases = [
    () => deriveDrives({}),
    () => deriveDrives({ drives: 'not-an-object' }),
    () => collectOpenLoops({ messages: 'not-an-array' }),
    () => collectOpenLoops({ messages: [null, undefined, {}, { time: 'x' }] }),
    () => buildIntentBlock({}),
    () => topNeeds(null),
    () => needAffinity(null),
    () => analyzePersonaBias(undefined),
    () => textSimilarity(null, undefined),
  ]
  let threw = ''
  for (const fn of cases) { try { fn() } catch (e) { threw = e.message } }
  check('全部不抛', threw === '', threw)
}

console.log('\n[14] 永久惦记陷阱：同一件事被提过就该降权，而不是每轮等权出现')
{
  const now = Date.now()
  const msgs = [
    msg('明天要考试了，得早点睡', { time: now - 20 * HOUR }),
  ]
  const seen0 = collectOpenLoops({ messages: msgs, now })
  check('第一次出现时权重正常', seen0.length === 1 && seen0[0].weight > 0.5, JSON.stringify(seen0.map((l) => l.weight)))

  const key = seen0[0].text
  const mk = (n, ago = 2 * HOUR) => ({ [key]: { count: n, lastAt: now - ago } })

  const seen1 = collectOpenLoops({ messages: msgs, now, seenLoops: mk(1) })
  const seen3 = collectOpenLoops({ messages: msgs, now, seenLoops: mk(3) })
  const seen5 = collectOpenLoops({ messages: msgs, now, seenLoops: mk(5) })
  check('提过 1 次 → 权重降了', seen1[0].weight < seen0[0].weight, `${seen1[0].weight} vs ${seen0[0].weight}`)
  check('提过 3 次 → 降得更多', seen3[0].weight < seen1[0].weight, `${seen3[0].weight} vs ${seen1[0].weight}`)
  check('提过很多次 → 不再提（不是永远挂着）', seen5.length === 0, JSON.stringify(seen5.map((l) => l.weight)))

  // 隔一天之后应该回升（那件事还在，只是不新了）
  const dayLater = collectOpenLoops({ messages: msgs, now, seenLoops: mk(3, 25 * HOUR) })
  check('隔一天后权重回升（时间翻新）', dayLater.length === 1 && dayLater[0].weight > seen3[0].weight,
    `${dayLater[0]?.weight} vs ${seen3[0].weight}`)

  // applyFamiliarity 独立可用
  const raw = [{ text: 'a', weight: 1, ageMs: 1000 }]
  const applied = applyFamiliarity(raw, { a: { count: 1, lastAt: now - HOUR } }, now)
  check('applyFamiliarity 单独调用也降权', applied[0].weight < 1)
  check('降权比例可读（familiarity）', typeof applied[0].familiarity === 'number')
}

console.log('\n[15] 幂等性：同样的入参算多少次都得同一个结果（重复调用不许累积推高）')
{
  const noJitter = () => 0.5
  const args = {
    drives: { ...DEFAULT_DRIVES },
    drivesAt: Date.now() - 3 * HOUR,
    now: Date.now(),
    lastMasterAt: Date.now() - 5 * HOUR,
    materials: [{ text: '好累啊 想你', time: Date.now() - 2 * HOUR }],
    random: noJitter,
  }
  const r1 = deriveDrives(args).drives
  const r2 = deriveDrives(args).drives
  const r3 = deriveDrives(args).drives
  const same = (a, b) => NEEDS.every((n) => Math.abs(a[n] - b[n]) < 1e-9)
  check('第一次与第二次一致', same(r1, r2), `${r1.share.toFixed(4)} vs ${r2.share.toFixed(4)}`)
  check('第三次也一致（不会越算越满）', same(r1, r3), `${r1.share.toFixed(4)} vs ${r3.share.toFixed(4)}`)
  check('drivesAt=0 时也能算（不抛）', Number.isFinite(deriveDrives({ ...args, drivesAt: 0 }).drives.share))

  const old = deriveDrives({
    ...args, materials: [{ text: '好累啊 想你', time: Date.now() - 30 * HOUR }],
  }).drives
  const fresh = deriveDrives({
    ...args, materials: [{ text: '好累啊 想你', time: Date.now() - 1 * HOUR }],
  }).drives
  check('刚看到的素材影响更大（时效衰减）', fresh.care >= old.care, `${fresh.care.toFixed(3)} vs ${old.care.toFixed(3)}`)
}

console.log('\n[16] 幂等性（关键）：**不给固定 random** 时也必须一致')
{
  // ⚠ 上一节用了 random: () => 0.5，所以没抓到"抖动用随机数"这个 bug。
  // 真实调用不传 random，于是每次算出不同的倾向（实测 0.64/0.65/0.63），
  // 同一回合里唤醒提示与会话提示会不一致。
  const args = {
    drives: { ...DEFAULT_DRIVES },
    drivesAt: Date.now() - 3 * HOUR,
    now: Date.now(),
    lastMasterAt: Date.now() - 5 * HOUR,
    materials: [{ text: '好累啊 想你', time: Date.now() - 2 * HOUR }],
  }
  const runs = [1, 2, 3, 4, 5].map(() => deriveDrives(args).drives)
  const allSame = runs.every((d) => NEEDS.every((n) => Math.abs(d[n] - runs[0][n]) < 1e-12))
  check('连算 5 次完全一致（抖动用确定性哈希，不用随机数）', allSame,
    runs.map((d) => d.share.toFixed(4)).join(' / '))

  // 但跨分钟应该允许变化（否则就是死的常量）。
  // ⚠ 用固定的 now 做基准，别用 Date.now() —— 否则测试跑在分钟边界上会偶发不稳
  // （第一次跑就因为这个失败过一次）。
  const fixedNow = Math.floor(Date.now() / 60000) * 60000
  const base = { ...args, now: fixedNow }
  const a1 = deriveDrives(base).drives
  const a2 = deriveDrives({ ...base, now: fixedNow + 5 * 60 * 1000 }).drives
  check('跨分钟允许自然变化（不是死常量）',
    NEEDS.some((n) => Math.abs(a2[n] - a1[n]) > 1e-9),
    '五分钟后的结果与现在完全相同')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
