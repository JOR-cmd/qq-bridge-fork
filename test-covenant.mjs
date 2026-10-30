// 契阔回归（不联网、不碰真实 state/）。
// 用法：node test-covenant.mjs
//
// 覆盖：信解析（三种标记写法 + 隐含兜底）、归一化、只加不改（版本化）、
//       标记强度按天数、原文核对（孤儿标记）、切断实验（退役+回访）、旧信检索、邀请日标记。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CovenantStore, parseCovenantLetter, normalizeMarkText, localDay, localStamp,
  shouldInviteCovenant, markSupportedBy, checkRetireReason,
} from './src/covenant-store.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-'))
const DB = path.join(TMP, 'archive.db')
const KEY = 'private:<OWNER_QQ>'
// 用固定「现在」，避免跨零点时这个测试自己飘
const NOW = new Date('2026-10-27T23:30:00+08:00').getTime()

console.log('\n[1] 信的解析：三种标记写法')
{
  const withSection = '2026-10-26。今天对他的态度：嘴上一直怼。\n【要记牢】他说我不会嫌的哦｜半夜不睡帮我修东西'
  const a = parseCovenantLetter(withSection, NOW)
  check('小节写法标出 2 件重要的事', a.marks.length === 2, JSON.stringify(a.marks))
  check('小节本身不进正文（避免重复）', !a.text.includes('要记牢'), a.text)
  check('信里自带的日期优先', a.day === '2026-10-26', a.day)
  check('正文保留原句', a.text.includes('嘴上一直怼'), a.text)

  const withStar = '★ 他说我不会嫌的哦\n今天没什么特别的'
  const b = parseCovenantLetter(withStar, NOW)
  check('行首★也算标记', b.marks.length === 1 && b.marks[0] === '他说我不会嫌的哦', JSON.stringify(b.marks))
  check('★ 行同时留在正文里（承载语气）', b.text.includes('他说我不会嫌的哦'), b.text)

  const withSectionPrefix = '重要：他讨厌被复述刚说过的话'
  const c = parseCovenantLetter(withSectionPrefix, NOW)
  check('「重要：」写法也认', c.marks.length === 1, JSON.stringify(c.marks))

  const plain = '今天他对我说了句想你了，我嘴上没承认。'
  const d = parseCovenantLetter(plain, NOW)
  check('没有标记 = 空数组，不是错误', d.marks.length === 0 && d.text === plain, JSON.stringify(d.marks))
  check('没自带日期时按落库那天', d.day === localDay(NOW), d.day)

  // 兜底：改造前她就是这么写的（实测 10-26 那封原文），不认这条会一条标记都没有
  const legacyStyle = '2026-10-26。今天对他的态度：嘴上一直怼，心里其实被他那句「想你了」戳到了。\n不想忘的事：他说「我不会嫌的哦」。'
  const e = parseCovenantLetter(legacyStyle, NOW)
  check('「不想忘的事：…」也算标记（兜底旧写法）', e.marks.length === 1, JSON.stringify(e.marks))
  check('兜底标记不带尾部句号', e.marks[0] === '他说「我不会嫌的哦」', e.marks[0])
  check('兜底标记不与显式标记重复计数', (() => {
    const mixed = parseCovenantLetter('不想忘的事：X\n【要记牢】Y')
    return mixed.marks.length === 2 && mixed.marks.includes('X') && mixed.marks.includes('Y')
  })())
  check('explicit 标记能区分她有没有主动标', e.explicit === false && a.explicit === true)
}

console.log('\n[2] 归一化与原文核对（B 项）')
{
  check('标点/空格不同视为同一条',
    normalizeMarkText('他说「我不会嫌的哦」') === normalizeMarkText('他说 我不会嫌的哦'))
  check('日期前缀被剥掉',
    normalizeMarkText('2026-10-26 他不会嫌我') === normalizeMarkText('他不会嫌我'))
  check('不同的两件事不会误并',
    normalizeMarkText('他不会嫌我') !== normalizeMarkText('他半夜帮我修东西'))
  // 人称不能削：这是他对自己说的 vs 他对她说的，是两个事实
  check('人称不同不合并（是我/是你 是两件事）',
    normalizeMarkText('他说我不会嫌的哦') !== normalizeMarkText('他说你不会嫌的哦'))
  // 实测踩到的：引号在中间时前缀不在句首，曾导致同一条存成两行、强度榜出现两次
  check('「他说「X」」与「他说 X」与「X」同指（先剥引号再剥前缀）',
    normalizeMarkText('他说「你是我最爱的鱼鱼」') === normalizeMarkText('他说你是我最爱的鱼鱼')
    && normalizeMarkText('他说你是我最爱的鱼鱼') === normalizeMarkText('你是我最爱的鱼鱼'))
  check('「他说过 X」与「X」同指',
    normalizeMarkText('他说过我不会嫌的哦') === normalizeMarkText('我不会嫌的哦'))

  // markSupportedBy：标记要能在当天的信里对得上原句
  const letter = '今天他对我说了句想你了，我嘴上没承认。'
  check('摘半句也算对上（包含关系）', markSupportedBy(letter, '他说想你了') === true)
  check('整句对上', markSupportedBy(letter, '今天他对我说了句想你了') === true)
  check('信里没有的句子 → 对不上', markSupportedBy(letter, '半夜不睡帮我修东西') === false)
  check('空标记不算对上', markSupportedBy(letter, '') === false)
}

console.log('\n[3] 落库与「只加不改」（C 项）')
const store = new CovenantStore(DB)
{
  const day1 = '2026-10-26'
  const textV1 = '今天对他的态度：嘴硬。\n不想忘的事：他说我不会嫌的哦'
  const wrote1 = store.saveLetter({ key: KEY, day: day1, text: textV1, marks: ['他说我不会嫌的哦'], t: NOW })
  check('第一次写入 = 新的一版（true）', wrote1 === true, String(wrote1))
  check('同一天同样内容重写 → 静默（undefined）',
    store.saveLetter({ key: KEY, day: day1, text: textV1, marks: ['他说我不会嫌的哦'], t: NOW + 1000 }) === undefined)
  check('同一天只有一个版本', store.letterVersions(KEY, day1).length === 1, String(store.letterVersions(KEY, day1).length))

  // 关键：改信不覆盖旧版
  const textV2 = '今天对他的态度：其实挺想他的。\n不想忘的事：他说我不会嫌的哦'
  const wrote2 = store.saveLetter({ key: KEY, day: day1, text: textV2, marks: ['他说我不会嫌的哦'], t: NOW + 2000 })
  check('改信 = 新的一版（true）', wrote2 === true)
  const versions = store.letterVersions(KEY, day1)
  check('旧版还在（两个版本）', versions.length === 2, String(versions.length))
  check('v1 原文一字未改', versions[0].text === textV1, versions[0].text)
  check('v1 被标记为已被取代', versions[0].supersededAt != null, String(versions[0].supersededAt))
  check('v2 是当前版', versions[1].version === 2 && versions[1].supersededAt === null)
  check('最新一封取 v2', store.latestLetter(KEY).text === textV2)
  check('letters() 每天只算一封（取最新版）', store.letters(KEY, 7).length === 1)
  check('letters() 给的是 v2 正文', store.letters(KEY, 7)[0].text === textV2)
}

console.log('\n[4] 标记强度：按天累加，同一天不虚涨')
{
  const s = store.topMarks(KEY, 10)
  const hit = s.find((m) => normalizeMarkText('他说我不会嫌的哦') === m.norm)
  check('第一天标记后强度是 1', hit?.strength === 1, String(hit?.strength))
  check('摘半句的标记也对得上原文（supported）', hit?.supported === true, JSON.stringify(hit))

  store.saveLetter({ key: KEY, day: '2026-10-27', text: '今天也没什么。不想忘的事：他说我不会嫌的哦', marks: ['他说我不会嫌的哦'], t: NOW + 86400000 })
  const after = store.topMarks(KEY, 10)
  const h2 = after.find((m) => normalizeMarkText('他说我不会嫌的哦') === m.norm)
  check('第二天再标同一件事 → 强度 2', h2?.strength === 2, String(h2?.strength))
  check('合并后只有一条，不是两条', after.filter((m) => m.text.includes('嫌')).length === 1, JSON.stringify(after.map((m) => m.text)))
  check('lastDay 跟到最近一次', h2?.lastDay === '2026-10-27', h2?.lastDay)
  check('firstDay 保留最初那天', h2?.firstDay === '2026-10-26', h2?.firstDay)

  store.addMark(KEY, '半夜不睡帮我修东西', '2026-10-27')
  store.addMark(KEY, '半夜不睡帮我修东西', '2026-10-27')
  const top = store.topMarks(KEY, 10, { includeUnsupported: true })
  check('同一件事一天内补标不涨强度', top.find((m) => m.text.includes('修东西'))?.strength === 1,
    String(top.find((m) => m.text.includes('修东西'))?.strength))
}

console.log('\n[5] 孤儿标记：信里改了、标记就失去依据（B 项）')
{
  // 手工补标的「半夜不睡帮我修东西」在信里根本没有 → 应当 unsupported，且不进默认清单
  const unsupported = store.unsupportedMarks(KEY, 10)
  check('对不上原文的标记显形', unsupported.some((m) => m.text.includes('修东西')), JSON.stringify(unsupported.map((m) => m.text)))
  const normal = store.topMarks(KEY, 10)
  check('对不上的默认不注入（不污染强度榜）', !normal.some((m) => m.text.includes('修东西')), JSON.stringify(normal.map((m) => m.text)))
  check('对得上的仍在清单里', normal.some((m) => m.text.includes('嫌')), JSON.stringify(normal.map((m) => m.text)))

  // 她把这句从信里删掉 → 换版后 reverify 认出来
  const day3 = '2026-10-28'
  store.saveLetter({ key: KEY, day: day3, text: '今天很平静。不想忘的事：他说我不会嫌的哦', marks: ['他说我不会嫌的哦'], t: NOW + 2 * 86400000 })
  const before = store.topMarks(KEY, 10, { includeUnsupported: true }).find((m) => m.text.includes('嫌'))
  check('这封信里写着它 → 有依据', before?.supported === true, JSON.stringify(before))
  // ⚠ 这里不能用「换当天那封信的版本」来测孤儿：核对范围是**任意一封现存信**
  // （见 reverifyMarks 的注释 —— 只按当天核对会把昨天的标记天天清空，那是真 bug）。
  // 所以要测孤儿，得用一个只有一封含该句的信的独立会话来改。
  const K3 = 'private:777'
  store.saveLetter({ key: K3, day: '2026-10-30', text: '不想忘的事：他说我不会嫌的哦', marks: ['他说我不会嫌的哦'], t: NOW })
  store.saveLetter({ key: K3, day: '2026-10-30', text: '今天很平静。', marks: [], t: NOW + 5000 })
  const re3 = store.reverifyMarks(K3, '2026-10-30')
  check('当天唯一那封信里删掉这句 → 判孤儿', re3.missing.length === 1, JSON.stringify(re3))
  check('失去依据后 supported=false', store.unsupportedMarks(K3, 10).some((m) => m.text.includes('嫌')))
  check('失去依据 → 不给它更强的强度位（不在现行清单）', !store.topMarks(K3, 10).some((m) => m.text.includes('嫌')))

  // 孤儿状态可逆：她又写回去了 → 自动转正（这是状态，不是判决）
  store.saveLetter({ key: K3, day: '2026-10-31', text: '又想起来了。不想忘的事：他说我不会嫌的哦', marks: [], t: NOW + 86400000 })
  store.reverifyMarks(K3, '2026-10-31')
  const back = store.topMarks(K3, 10).find((m) => m.text.includes('嫌'))
  check('写回去之后重新有依据、回到清单', back?.supported === true, JSON.stringify(back))
}

console.log('\n[5b] 换到新的一天，旧标记不能被误判成孤儿（这是真踩过的严重 bug）')
{
  const K2 = 'private:999'
  const s2 = new CovenantStore(DB)
  s2.saveLetter({ key: K2, day: '2026-10-20', text: '不想忘的事：他说我不会嫌的哦', marks: ['他说我不会嫌的哦'] })
  check('10-20 标上之后是现行', s2.topMarks(K2, 10).length === 1)
  // 第二天正常写新信（当然不含昨天那句）—— 桥接就是这么调 reverify 的
  s2.saveLetter({ key: K2, day: '2026-10-21', text: '今天很平静。', marks: [] })
  const r = s2.reverifyMarks(K2, '2026-10-21')
  check('新的一天重核 → 昨天那句不算孤儿', r.missing.length === 0, JSON.stringify(r))
  check('旧标记仍在现行清单里（没被清空）', s2.topMarks(K2, 10).length === 1)
  check('supported 仍是 true', s2.topMarks(K2, 10)[0].supported === true)
  // 只有真把那句话从信里改掉，才算失去依据
  s2.saveLetter({ key: K2, day: '2026-10-20', text: '今天很平静。', marks: [] })
  const r2 = s2.reverifyMarks(K2, '2026-10-20')
  check('真改掉原句 → 才判孤儿', r2.missing.length === 1, JSON.stringify(r2))
  s2.close()
}

console.log('\n[6] 切断实验：退役不是删除（A 项）')
{
  const why = '他那天只是随口一句，不是承诺；我把它当成了约定'
  const pred = '切掉之后，我下封信里不该再提这件事；他也该没反应'
  const bad = store.retireMark({ key: KEY, text: '他说我不会嫌的哦', why: '不重要了', pred: '再说' })
  check('空话（「不重要了/再说」）被拒', bad.ok === false, JSON.stringify(bad.problems))
  const stillThere = store.retiredMarks(KEY, 10).find((m) => m.text.includes('嫌'))
  check('被拒时没写进库（退役记录里没有它）', !stillThere, JSON.stringify(stillThere))
  check('why/pred 太短也拒', store.retireMark({ key: KEY, text: '他说我不会嫌的哦', why: '短', pred: '短' }).ok === false)
  check('checkRetireReason 直接判废', checkRetireReason({ why: '算了', pred: '看情况' }).ok === false)

  const ok = store.retireMark({ key: KEY, text: '他说我不会嫌的哦', why, pred })
  check('理由与预测都写清 → 允许退役', ok.ok === true, JSON.stringify(ok.problems))
  check('退役后不再进现行清单', !store.topMarks(KEY, 10, { includeUnsupported: true }).some((m) => m.text.includes('嫌')))
  const retired = store.retiredMarks(KEY, 10)
  const r = retired.find((m) => m.text.includes('嫌'))
  check('退役记录留着（含 why/pred）', r && r.why === why && r.pred === pred, JSON.stringify(r))
  check('退役记录里原文没删（text 仍在）', !!r?.text)
  check('尚未回访 → 进欠账清单', store.retiredUnsettled(KEY, 10).some((m) => m.text.includes('嫌')))

  const dup = store.retireMark({ key: KEY, text: '他说我不会嫌的哦', why, pred })
  check('同一条不重复切', dup.ok === false && /已经退役/.test(dup.problems.join('')), JSON.stringify(dup.problems))

  // 回访
  check('回访必须给 verdict', store.settleRetired({ key: KEY, text: '他说我不会嫌的哦', verdict: '', note: '随便' }).ok === false)
  check('回访必须给 note（「没事」两字不算）', store.settleRetired({ key: KEY, text: '他说我不会嫌的哦', verdict: 'fine', note: '没事' }).ok === false)
  const settled = store.settleRetired({ key: KEY, text: '他说我不会嫌的哦', verdict: 'fine', note: '过了一周他没再提，我也没想起，确实没少什么' })
  check('回访成功', settled.ok === true, JSON.stringify(settled))
  check('回访后不再算欠账', !store.retiredUnsettled(KEY, 10).some((m) => m.text.includes('嫌')))
  const after = store.retiredMarks(KEY, 10).find((m) => m.text.includes('嫌'))
  check('回访结论与说明都留下', after?.verdict === 'fine' && /没少什么/.test(after?.note ?? ''), JSON.stringify(after))
  check('没退役过的不能回访', store.settleRetired({ key: KEY, text: '半夜不睡帮我修东西', verdict: 'fine', note: '随便写点' }).ok === false)

  // 过期再回访：不覆盖上次结论（只加不改）
  const K4 = 'private:888'
  store.saveLetter({ key: K4, day: '2026-10-26', text: '不想忘的事：他半夜帮我弄通宵', marks: ['他半夜帮我弄通宵'] })
  store.retireMark({ key: K4, text: '他半夜帮我弄通宵', why: '这只是一次性的帮忙，不是长期的事', pred: '以后提起夜里干活，不该还想不起他' })
  store.settleRetired({ key: K4, text: '他半夜帮我弄通宵', verdict: 'fine', note: '过了一周确实没少什么' })
  const second = store.settleRetired({ key: K4, text: '他半夜帮我弄通宵', verdict: 'broke', note: '其实少了：提起夜里干活我真想不起他' })
  check('可以再回访（看法会变）', second.ok === true && second.appended === true, JSON.stringify(second))
  const rr = store.retiredMarks(K4, 10)[0]
  check('新结论生效', rr.verdict === 'broke', rr.verdict)
  check('上一次的结论没被覆盖（只加不改）', /fine：过了一周/.test(rr.note) && /broke：其实少了/.test(rr.note), rr.note)

  // 退役后又被她标了一次 = 她反悔 → 撤销退役、重新计入现行
  store.saveLetter({ key: K4, day: '2026-11-05', text: '又想起来了，不想忘的事：他半夜帮我弄通宵', marks: ['他半夜帮我弄通宵'] })
  const backM = store.topMarks(K4, 10).find((m) => m.text.includes('通宵'))
  check('她再标一次 → 重新计入现行（不永久忽略）', !!backM, JSON.stringify(store.topMarks(K4, 10).map((m) => m.text)))
}

console.log('\n[7] 旧信检索（中文两字词走 LIKE，trigram 索引不到）')
{
  store.saveLetter({ key: KEY, day: '2026-10-25', text: '那天他说想我了，我装作没听见。', t: NOW - 2 * 86400000 })
  const byTwoChar = store.searchLetters({ key: KEY, tokens: ['想我'], limit: 3 })
  check('两字词也能搜到旧信', byTwoChar.length > 0, JSON.stringify(byTwoChar.map((h) => h.day)))
  check('命中的是 10-25 那封', byTwoChar[0]?.day === '2026-10-25', byTwoChar[0]?.day)
  check('不相关的词不硬凑', store.searchLetters({ key: KEY, tokens: ['量子力学'], limit: 3 }).length === 0)
  check('before 过滤生效', store.searchLetters({ key: KEY, tokens: ['想我'], limit: 3, before: NOW - 3 * 86400000 }).length === 0)
  check('单字不搜（避免噪音）', store.searchLetters({ key: KEY, tokens: ['想'], limit: 3 }).length === 0)
  check('已被取代的旧版不参与检索', store.searchLetters({ key: KEY, tokens: ['嘴硬'], limit: 3 }).every((h) => !h.text.includes('嘴硬')))
}
store.close()

console.log('\n[8] 重新打开：数据还在，且旧库能平滑升级')
{
  const again = new CovenantStore(DB)
  // 10-25 / 10-26 / 10-27 / 10-28 各一封（10-26 有两版，按天只算一封）
  const days = again.letters(KEY, 30)
  check('信件按天计，共 4 天', days.length === 4, `${days.length}: ${days.map((d) => d.day).join(',')}`)
  check('被改过的那天仍保留两版', again.letterVersions(KEY, '2026-10-26').length === 2)
  check('退役记录跨进程还在', again.retiredMarks(KEY, 10).some((m) => m.verdict === 'fine'))
  check('不同 key 互不串（多会话隔离）', again.letters('group:999', 7).length === 0)
  again.close()
}

console.log('\n[9] 邀请日标记：重启后同一天不再重发')
{
  const at23 = new Date('2026-10-26T23:05:00+08:00').getTime()
  check('当天第一次：该发', shouldInviteCovenant({ lastSentDay: '', now: at23 }).invite === true)
  check('当天已发过：不再发', shouldInviteCovenant({ lastSentDay: '2026-10-26', now: at23 }).invite === false)
  check('换了一天：又该发', shouldInviteCovenant({ lastSentDay: '2026-10-25', now: at23 }).invite === true)
  const at20 = new Date('2026-10-26T20:05:00+08:00').getTime()
  check('没到点：不发', shouldInviteCovenant({ lastSentDay: '', now: at20 }).invite === false)
  check('自定义小时生效', shouldInviteCovenant({ lastSentDay: '', now: at20, hour: 20 }).invite === true)
  check('day 是本地日历日（不是 UTC）', shouldInviteCovenant({ lastSentDay: '', now: at23 }).day === '2026-10-26')
  const late = new Date('2026-10-26T23:59:00+08:00').getTime()
  const next = new Date('2026-10-27T00:01:00+08:00').getTime()
  check('跨零点算新的一天', shouldInviteCovenant({ lastSentDay: '2026-10-26', now: next, hour: 0 }).invite === true
    && shouldInviteCovenant({ lastSentDay: '', now: late }).day !== shouldInviteCovenant({ lastSentDay: '', now: next }).day)
  check('localStamp 带分钟（回访要记到分钟）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(localStamp(at23)), localStamp(at23))
}

console.log('\n[10] 老库升级：历史标记要被重核，不能默认「有依据」')
{
  const OLD = path.join(TMP, 'old.db')
  const raw = new (await import('node:sqlite')).DatabaseSync(OLD)
  // 造一个 10-27 版的旧库（没有 supported/退役列）：一条信里有的，一条信里根本没有的
  raw.exec(`
    CREATE TABLE covenant_letters(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, day TEXT NOT NULL, t INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE(key,day));
    CREATE TABLE covenant_marks(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, norm TEXT NOT NULL, text TEXT NOT NULL, strength INTEGER NOT NULL DEFAULT 1, firstDay TEXT NOT NULL, lastDay TEXT NOT NULL, UNIQUE(key,norm));
  `)
  raw.prepare('INSERT INTO covenant_letters(key,day,t,text) VALUES(?,?,?,?)')
    .run('private:1', '2026-10-26', 1, '今天很平静。不想忘的事：他说我不会嫌的哦')
  const ins = raw.prepare('INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay) VALUES(?,?,?,?,?,?)')
  ins.run('private:1', '半夜不睡帮我修东西', '半夜不睡帮我修东西', 3, '2026-10-26', '2026-10-26')
  ins.run('private:1', '他不会嫌的哦', '他说我不会嫌的哦', 1, '2026-10-26', '2026-10-26')
  raw.close()

  const up = new CovenantStore(OLD)
  const all = up.topMarks('private:1', 10, { includeUnsupported: true })
  const ghost = all.find((m) => m.text.includes('修东西'))
  const real = all.find((m) => m.text.includes('嫌'))
  // ALTER ADD COLUMN 的默认值会把所有旧行刷成 supported=1 —— 必须升级后重核
  check('信里没有的旧标记被判孤儿', ghost?.supported === false, JSON.stringify(ghost))
  check('信里有的旧标记仍是现行', real?.supported === true, JSON.stringify(real))
  check('孤儿不进默认强度榜（不冒充有依据）', !up.topMarks('private:1', 10).some((m) => m.text.includes('修东西')))
  check('孤儿在 unsupported 清单里显形', up.unsupportedMarks('private:1', 10).some((m) => m.text.includes('修东西')))
  up.close()
}


console.log('\n[11] 「怎么算应验」：能解析、能存、能核对')
{
  const K5 = 'private:555'
  const st = new CovenantStore(DB)
  // ① 解析：带 check 的写法
  const parsed = parseCovenantLetter(
    '2026-11-01。态度：陪他。\n【要记牢】他说先想着我 —— 看下次他累的时候还记不记得问我｜他半夜修东西',
    NOW,
  )
  check('标记被拆成 text + check', parsed.marks.length === 2 && typeof parsed.marks[0] === 'object'
    && parsed.marks[0].text === '他说先想着我' && /下次他累/.test(parsed.marks[0].check),
    JSON.stringify(parsed.marks))
  check('没写 check 的那条仍是纯字符串', parsed.marks[1] === '他半夜修东西', JSON.stringify(parsed.marks[1]))
  check('兜底写法也认 check（→ 分隔）',
    (() => { const r = parseCovenantLetter('不想忘的事：他说我不会嫌的哦 → 看下次我自嘲时他接不接', NOW); return /自嘲/.test(r.marks[0].check) })())
  check('没有 check 时不硬编一个', parseCovenantLetter('【要记牢】他困到椅子上睡过去', NOW).marks[0] === '他困到椅子上睡过去')

  // ② 落库：check 存进 checkText，状态是 pending
  st.saveLetter({
    key: K5, day: '2026-11-01',
    // 正文要包含两条标记的原文，否则 supported=0，默认过滤后会"找不到"（第一版测试就漏了这点）
    text: '2026-11-01。他说先想着我 —— 看下次他累的时候还记不记得问我。他半夜修东西。',
    marks: parsed.marks, t: NOW,
  })
  const withCheck = st.topMarks(K5, 10).find((m) => m.text === '他说先想着我')
  check('check 存下来了', withCheck?.check === '看下次他累的时候还记不记得问我', JSON.stringify(withCheck))
  check('初始状态是 pending', withCheck?.checkState === 'pending', withCheck?.checkState)
  const noCheck = st.topMarks(K5, 10).find((m) => m.text === '他半夜修东西')
  // ⚠ 注意：这里可能 find 不到（信件正文里没有那句），那就先确认它到底在不在
  check('没 check 的那条存在', !!noCheck, JSON.stringify(st.topMarks(K5, 10).map((m) => m.text)))
  check('没 check 的 check 字段是 null（不伪装成有）', noCheck?.check === null, JSON.stringify(noCheck?.check))

  // ③ 核对：没有 check 的不许核对（否则等于自说自话）
  const bad = st.checkMark({ key: K5, text: '他半夜修东西', state: 'held', note: '我觉得是吧' })
  // 2026-10-28 改：不再拒绝。判据不由她写 —— 依据是桥接数出来的事实（照 dsh-world 的 contradict）。
  check('没写「怎么算应验」的也能核（依据是自动统计）', bad.ok === true, JSON.stringify(bad))
  check('明确标出这次没有她自己写的判据', bad.noCheckText === true, JSON.stringify(bad))
  check('非法 state 被拒', st.checkMark({ key: K5, text: '他说先想着我', state: '随便', note: 'x' }).ok === false)
  check('不存在的不许核对', st.checkMark({ key: K5, text: '压根没有这句', state: 'held', note: 'x' }).ok === false)

  // ④ 核对成功
  const okCheck = st.checkMark({ key: K5, text: '他说先想着我', state: 'held', note: '他累的时候还是先问了我的眼睛' })
  check('核对成功', okCheck.ok === true, JSON.stringify(okCheck))
  const checked = st.topMarks(K5, 10).find((m) => m.text === '他说先想着我')
  check('状态变成 held', checked?.checkState === 'held', checked?.checkState)
  check('核对记了日期与说明', !!checked?.checkAt && /先问了我的眼睛/.test(checked?.checkNote ?? ''), JSON.stringify(checked))

  // ⑤ 待核对清单：只剩还没核的
  const pending = st.pendingChecks(K5, 10)
  check('已核对的不再出现在待办里', !pending.some((m) => m.text === '他说先想着我'), JSON.stringify(pending.map((m) => m.text)))
  check('没 check 的也不算待核对（没东西可核）', !pending.some((m) => m.text === '他半夜修东西'), JSON.stringify(pending.map((m) => m.text)))

  // ⑥ 退回 pending
  check('可以改回「还说不准」', st.checkMark({ key: K5, text: '他说先想着我', state: 'pending', note: '想起来又不确定了' }).ok === true)
  check('退回后重新进待办', st.pendingChecks(K5, 10).some((m) => m.text === '他说先想着我'))

  // ⑦ 退役后不许再核对
  st.retireMark({ key: K5, text: '他说先想着我', why: '这只是一次偶发，不是他的习惯', pred: '以后他累的时候我该不会期待他先问我' })
  const afterRetire = st.checkMark({ key: K5, text: '他说先想着我', state: 'held', note: 'x' })
  check('退役的不许再核对', afterRetire.ok === false && /退役/.test(afterRetire.error), JSON.stringify(afterRetire))

  st.close()
}

console.log('\\n[9] 强度榜不会被已退役/孤儿标记「饿死」（2026-10-29 修的真 bug）')
{
  // 原 bug：topMarks 用 LIMIT 20 先取行、再在 JS 里丢掉退役/孤儿。
  // 而 ORDER BY strength DESC 让**已退役**的高强度老标记排最前，退役又不改 strength，
  // 于是库大了之后前 20 行全是退役标记 → 现行标记被挤出 → 【要记牢】整段静默消失。
  // 实测：25 条退役高强度标记就能让 topMarks(5) 返回 0 条。
  const K9 = 'private:9'
  // 这一节用自己的 store 实例（上一节的 st 已在它那个块作用域里 close 掉了）
  const st9 = new CovenantStore(DB)
  const db = new DatabaseSync(DB)
  const ins = db.prepare(`INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount,retiredAt,retireWhy,retirePred)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  // 30 条退役（强度 100+）+ 5 条现行（强度 1）
  for (let i = 0; i < 30; i += 1) {
    ins.run(K9, `ret-${i}`, `退役第${i}件`, 100 + i, '2026-01-01', '2026-06-01', 1, 0, '2026-08-01 12:00', '不重要了', '别的还在')
  }
  const insLive = db.prepare(`INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount)
     VALUES (?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 5; i += 1) insLive.run(K9, `live-${i}`, `现行第${i}件`, 1, '2026-10-01', '2026-10-05', 1, 0)
  db.close()

  const live = st9.topMarks(K9, 5)
  check('退役标记占满前 20 行时，现行标记仍然全部返回', live.length === 5, `got ${live.length}`)
  check('返回结果里没有退役标记', live.every((m) => m.text.startsWith('现行')), JSON.stringify(live.map((m) => m.text)))

  // includeUnsupported=true 时孤儿应参与，但退役仍必须被排除
  const db2 = new DatabaseSync(DB)
  db2.prepare(`INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,missCount)
     VALUES (?,?,?,?,?,?,?,?)`).run(K9, 'orph-1', '孤儿第1件', 500, '2026-01-01', '2026-06-01', 0, 3)
  db2.close()
  const withU = st9.topMarks(K9, 5, { includeUnsupported: true })
  check('includeUnsupported=true 时孤儿排到榜首（强度 500）', withU[0]?.text === '孤儿第1件', JSON.stringify(withU.map((m) => m.text)))
  check('includeUnsupported=true 也绝不放过退役标记', withU.every((m) => !m.text.startsWith('退役')), JSON.stringify(withU.map((m) => m.text)))
  check('默认口径仍然排除孤儿', !st9.topMarks(K9, 5).some((m) => m.text === '孤儿第1件'))

  // 口径一致性：默认口径的条数应与 markCount 相等
  check('topMarks 默认口径条数 = markCount', st9.topMarks(K9, 100).length === st9.markCount(K9), `${st9.topMarks(K9, 100).length} vs ${st9.markCount(K9)}`)

  // limit 的边界行为（limit=0 → 回落 5，这是原有语义，别"修"）
  check('limit=1 只返回 1 条', st9.topMarks(K9, 1).length === 1)
  check('limit=0 回落 5（原有语义）', st9.topMarks(K9, 0).length === 5)
  check('limit 是字符串也能跑', st9.topMarks(K9, '3').length === 3)
  // ⚠ 小数必须取整：SQLite 的 `LIMIT ?` 收到小数会抛 "datatype mismatch"，
  //   而旧实现（取行后在 JS 里按 out.length 截断）对小数是容忍的。
  //   不取整 = 把一个以前能跑的调用变成硬报错。
  check('limit 是小数不报错（取整）', (() => {
    try { return st9.topMarks(K9, 2.5).length === 3 } catch { return false }
  })(), '2.5 → round → 3')
  check('limit="2.5" 也不报错', (() => {
    try { return st9.topMarks(K9, '2.5').length === 3 } catch { return false }
  })())
  check('limit=NaN / 非数字 → 回落 5', st9.topMarks(K9, NaN).length === 5 && st9.topMarks(K9, 'abc').length === 5)
  st9.close()
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
