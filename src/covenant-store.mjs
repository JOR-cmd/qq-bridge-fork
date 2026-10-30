// 契阔的记忆化：把每天那封信写进 state/archive.db，并把她自己标出来的重要句子
// 做成带强度、可被推翻的「要记牢的」。
//
// ── 第一版（2026-10-27）的三个设计，现在已经改掉 ──────────────────────────
//
//   ① 同一天重写信 = 覆盖旧正文。
//      现在：**只加不改**。改过的信存成新版本，旧版本原样留着、能查。
//      理由（照 dsh-retcon 的「第一节写完不改」）：改了原文，你就再也看不见
//      「我当时真觉得是什么」。她第二天把「他今天有点冷淡」改成「他今天挺温柔的」，
//      留下的不该只有温柔那版。
//
//   ② 标记 strength 只涨不降，而且没有任何退出路径。
//      现在：**丢弃是一次切断实验，不是删除**（照它的 cut_ledger.py）。
//      退役要写 why（为什么觉得它不重要）+ pred（切掉之后什么该还在），
//      过一段回来看塌了还是没事。退役的标记不再注入，但记录留着。
//
//   ③ 标记与信脱钩：信改了、甚至信没了，标记照样在，还继续累加。
//      现在：收信时核对——标记里的原句必须能在**当天的信**里找到。
//      找不到的进「对不上」清单，不再计入强度（孤儿标记）。
//
// ⚠️ 不照搬它的一点：封存是**刻意行为**，写不出推翻条件就拒收是对的；
//    契阔是**每天固定要写的信**，拒收等于把那天整封丢掉。所以这里降级为
//    「记下来、标出问题、下次提醒」，不拒绝写入。
//
// 数据仍然全在 archive.db 里，跟着每日 VACUUM INTO 备份走。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 行首标记：★ / ⭐ / * / ! / ！
const LINE_MARK = /^\s*[★⭐*!！]\s*/
// 显式小节：要记牢 / 记牢 / 重要
const SECTION = /^\s*【?\s*(要记牢|记牢|重要|别忘了)\s*】?\s*[:：]?\s*/
// 隐含标记：「一件不想忘的事：…」「别忘了…」「记住…」——兜底用，见 parseCovenantLetter
const IMPLICIT_MARK = /(?:不想忘的事|不想忘的|别忘了|不要忘|记住)[：:，,]?\s*(.+)$/
// 「怎么算应验」的行内写法：`【要记牢】X —— 看下次他累的时候还记不记得问我`
// 或 `【要记牢】X（怎么算：<她的核对办法>）`
// 分隔符用「——」/「→」/「怎么算：」，都见过她实际会用。
const CHECK_SEP = /\s*(?:——|-->|→|⇒|怎么算[：:]|怎么算应验[：:]|应验[：:])\s*/

/** 本地日期 YYYY-MM-DD（不用 UTC，免得晚上写的信算到前一天）。 */
export function localDay(ms = Date.now()) {
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时间戳 YYYY-MM-DD HH:MM（回访/切断实验要记到分钟）。 */
export function localStamp(ms = Date.now()) {
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${localDay(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 归一化，只用于「同一件事」的合并判定（不用于显示）。
 * 去掉标点/空白/日期前缀与装饰标记 —— 她第二次写「他说我不会嫌的哦」要能合并到
 * 第一次的「他说「我不会嫌的哦」」，否则每天都会新增一条、强度永远停留在 1。
 *
 * ⚠️ 刻意**不**去掉「我/他/你」这类人称：『他说我不会嫌的哦』和『他说你不会嫌的哦』
 * 是两个不同的事实（前者是他对自己的承诺，后者是他对她说的），合并了就是把两件事
 * 压成一件。
 */
export function normalizeMarkText(text) {
  return String(text ?? '')
    .replace(/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/g, '')
    .replace(/[★⭐*!！]/g, '')
    .replace(/[\s\u3000]+/g, '')
    // ⚠️ 顺序要紧：先把引号与标点**全部**剥掉，再剥转述前缀。
    // 反过来做过一次，实测踩到：「他说「你是我最爱的鱼鱼」」剥完引号得到
    // 「他说你是我最爱的鱼鱼」→ 再剥前缀 →「你是我最爱的鱼鱼」；而另一种写法
    // 「他说你是我最爱的鱼鱼」没引号，前缀在句首 → 也被剥成同一个。
    // 但引号夹在中间时（「他说」后面紧跟全角括号）前缀不在句首，剥不到，
    // 于是同一条记忆存成了两行（norm 一个是「他说你是我最爱的鱼鱼」，
    // 另一个是「你是我最爱的鱼鱼」）—— 强度榜上同一件事出现两次。
    .replace(/[，。、；;：:,.!?！？「」『』“”"'‘’（）()\[\]【】…—－\-~～]/g, '')
    // 转述前缀是同指的常见变体：「他说过 X」「他说：X」→ X。
    // 只削这一个前缀（不碰主语本身），削完还不同的就不合并。
    .replace(/^(他说过|他说了|他说|她说过|她说了|她说)+/, '')
    .toLowerCase()
    .slice(0, 160)
}

/**
 * 把一条记忆原文拆成「正文 + 标记列表」。
 *
 * 认三种写法（都会被她实际用来写）：
 *   ① 单独一行 `【要记牢】他说我不会嫌的哦｜半夜不睡帮我修东西`
 *   ② 行首 ★：`★ 他说我不会嫌的哦`
 *   ③ 小节 `重要：xxx`
 * 其余行原样保留为正文（去掉标记符号，避免同一句话在提示词里出现两遍）。
 *
 * @returns {{text:string, marks:string[], day:string, explicit:boolean}}
 */
export function parseCovenantLetter(content, now = Date.now()) {
  const raw = String(content ?? '').replace(/\r\n?/g, '\n').trim()
  const marks = []
  const body = []
  let day = localDay(now)
  // 她会把日期写在最前面（「2026-10-26。今天对他的态度…」），信里自带日期就用它，
  // 否则按落库那天算 —— 跨零点补收时这两者可能差一天，以她写的为准。
  const dateAtHead = raw.match(/^\s*(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/)
  if (dateAtHead) {
    const [, y, m, d] = dateAtHead
    day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  // 显式标记比隐含兜底可信：带显式标记的行不再走隐含识别，
  // 否则「【要记牢】不想忘的事：他说…」这种写法会被算成两条、强度白涨一倍。
  let explicitFound = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rest = null
    const sec = trimmed.match(SECTION)
    if (sec) rest = trimmed.slice(sec[0].length)
    else if (LINE_MARK.test(trimmed)) rest = trimmed.replace(LINE_MARK, '')
    if (rest !== null) {
      explicitFound = true
      // 一条小节里可以用 ｜ / | 并列多件事
      for (const rawPiece of rest.split(/[｜|]/)) {
        const piece = rawPiece.trim().replace(LINE_MARK, '').trim()
        if (!piece) continue
        // 「要记牢」可以带一句「怎么算应验」：
        //   他说先想着我 —— 看下次他累的时候还记不记得问我
        // 拆开存：text 是那件事，check 是她自己的核对办法。
        const parts = piece.split(CHECK_SEP)
        const text = (parts[0] ?? '').trim()
        const check = parts.length > 1 ? parts.slice(1).join(' ').trim() : ''
        if (text) marks.push(check ? { text, check } : text)
      }
      // 形如「★ 他说…」的整行也是正文的一部分（它承载了那天的语气），保留但不带符号
      const kept = rest.trim()
      if (kept && !sec) body.push(kept)
      continue
    }
    body.push(trimmed)
    // 兜底：她的实测写法是「不想忘的事：他说「我不会嫌的哦」」——没有 ★ 也没有
    // 【要记牢】，但那一句本来就是她点名想留住的。旧版三行里第三行固定是
    // 「一件不想忘的事」，如果只认显式标记，改造前那种信一条标记都不会有，
    // 这套强度机制就空转了。所以这里也把「不想忘 / 别忘了 / 记住」这些前缀后面
    // 那句收成标记 —— 她没主动标时，靠这一层兜住。
    const implicit = trimmed.match(IMPLICIT_MARK)
    if (implicit) {
      let piece = implicit[1].trim()
      let check = ''
      const parts = piece.split(CHECK_SEP) // 兜底写法也允许带「怎么算应验」
      if (parts.length > 1) { piece = parts[0]; check = parts.slice(1).join(' ').trim() }
      piece = piece
        .replace(/^[「『"“]/, '')
        .replace(/[」』"”]$/, '')
        .replace(/[。．.，,；;]+$/, '')
        .trim()
      if (piece) marks.push(check ? { text: piece, check: check.replace(/[。．.，,；;]+$/, '').trim() } : piece)
    }
  }
  // 同一件事可能同时被「一句话里的不想忘」和「显式标记」提到，去重；
  // 但**不因为**存在显式标记就丢掉隐含的那条 —— 「不想忘的事：X」本身
  // 就是她说"我不想忘 X"，两个来源都是她的意愿。
  //
  // ⚠ 这里必须按 text 归一化后去重，不能 `new Set(marks)`：marks 里混了字符串和
  // {text,check} 两种形状，对象永远不等于字符串，同一句话会被算成两条。
  // 去重时**保留带 check 的那份**（有核对办法的更有价值）。
  const merged = new Map()
  for (const item of marks) {
    const text = typeof item === 'string' ? item : item.text
    const check = typeof item === 'string' ? '' : (item.check ?? '')
    if (!text) continue
    const norm = normalizeMarkText(text)
    if (!norm) continue
    const prev = merged.get(norm)
    if (!prev) { merged.set(norm, { text, check }); continue }
    // 后到的带 check 而先到的没有 → 用它补上
    if (check && !prev.check) prev.check = check
  }
  const unique = [...merged.values()].map((m) => (m.check ? m : m.text))
  return { text: body.join('\n').trim(), marks: unique, day, explicit: explicitFound }
}

/**
 * 标记的两种形状统一成 {text, check}。
 * 她写的时候可以是纯字符串（没写「怎么算应验」），也可以带一句核对办法。
 */
export function splitMark(mark) {
  if (!mark) return { text: '', check: '' }
  if (typeof mark === 'string') return { text: mark.trim(), check: '' }
  return { text: String(mark.text ?? '').trim(), check: String(mark.check ?? '').trim() }
}

/**
 * 「今天已经发过邀请了吗」的判定 + 落盘格式。
 *
 * 为什么单独抽出来：这个日标记原先只是桥接里的一个内存变量，
 * 桥接 10-26 晚上重启两次 → 同一天发了三次邀请（日志实证 23:00 / 23:52 / 23:58），
 * 靠她自己判断「契阔昨天已经写过了，今晚不重复」才没写三封。
 * 抽成纯函数才能回归，不至于哪天又被简化回内存。
 */
export function shouldInviteCovenant({ lastSentDay, now = Date.now(), hour = 23 } = {}) {
  const d = new Date(Number(now))
  if (d.getHours() !== Number(hour)) return { invite: false, day: '' }
  const day = localDay(now)
  return { invite: String(lastSentDay ?? '') !== day, day }
}

/**
 * 一条标记能不能在当天的信里找到依据。
 *
 * 照 dsh-retcon 的「证据指针」：每条判断都要能指到具体哪句话。
 * 这里落地为：标记的归一化文本，必须能在该信正文的归一化文本里找到
 * （允许标记是她从正文里摘的半句，所以用「包含」而不是「相等」）。
 * 找不到 = 孤儿标记（信改了/记岔了/跨天的旧事），不再计入强度。
 */
export function markSupportedBy(letterText, markText) {
  const letter = normalizeMarkText(letterText)
  const mark = normalizeMarkText(markText)
  if (!mark) return false
  if (!letter) return false
  // 只认「标记是信的一段」这一个方向（她摘半句、或摘整句）。
  // ⚠️ 曾经还有第二个条件 `mark.includes(letter.slice(0, 60%))`，那是个危险的洞：
  // 只要标记够长、包含信的前 60%，就算「有依据」—— 长信几乎必然通过，
  // 于是孤儿永远显不了形（实测她 5 条里有 2 条对不上，被这个后门放过了）。
  return letter.includes(mark)
}

/**
 * 「这对牌能不能算数」——照它的 FAKE_REFUTE，但换成契阔的场景。
 * 退役理由/预测写不出来、或者只写了废话，就是没写。
 */
const FAKE_REASON = ['不重要了', '没啥', '算了', '无所谓', '不想管', '随便', '忘了吧', '没用了', '懒得']
const FAKE_PRED = ['再说', '看情况', '顺其自然', '无所谓', '不知道', '没有了', '不会怎样', '没什么']

function looksLikeNothing(s) {
  const t = String(s ?? '').trim()
  if (t.length < 6) return true
  const bare = t.replace(/[，。、；：\s]/g, '')
  if (bare.length <= 8 && FAKE_REASON.some((w) => t.includes(w))) return true
  if (bare.length <= 8 && FAKE_PRED.some((w) => t.includes(w))) return true
  return false
}

/**
 * 检查一次「退役（切断实验）」的完整性。
 *
 * 照 cut_ledger 的三步：
 *   ① 说出为什么觉得它不重要（写不出的不许丢）
 *   ② 预测切掉之后什么该还在
 *   ③ 回来记「后来」——塌了还是没事
 * 第③步是事后填的，所以这里只校 ①②，返回人话原因。
 *
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkRetireReason({ why, pred } = {}) {
  const problems = []
  if (looksLikeNothing(why)) problems.push('why 太空：说不出「为什么觉得它不重要」，就不算切断实验，只是扔了')
  if (looksLikeNothing(pred)) problems.push('pred 太空：要写「切掉之后什么该还在」，否则事后没东西可核对')
  return { ok: problems.length === 0, problems }
}

export class CovenantStore {
  constructor(dbPath) {
    this.path = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;

      -- 「只加不改」：同一天改信 = 新增一版，旧版原样留着。
      -- 唯一约束从 (key,day) 改成 (key,day,version)。
      CREATE TABLE IF NOT EXISTS covenant_letters (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        key     TEXT NOT NULL,
        day     TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        t       INTEGER NOT NULL,
        text    TEXT NOT NULL,
        supersededAt INTEGER,
        UNIQUE(key, day, version)
      );
      CREATE INDEX IF NOT EXISTS idx_covenant_letters_key_day ON covenant_letters(key, day);

      -- 标记分「现行」与「已退役（切断实验）」两类，退役的不删、不再注入。
      CREATE TABLE IF NOT EXISTS covenant_marks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL,
        norm       TEXT NOT NULL,
        text       TEXT NOT NULL,
        strength   INTEGER NOT NULL DEFAULT 1,
        firstDay   TEXT NOT NULL,
        lastDay    TEXT NOT NULL,
        -- 下面几列是 2026-10-28 加的（A/B 项）
        supported  INTEGER NOT NULL DEFAULT 1,  -- 能在当天信里对上原句吗
        missCount  INTEGER NOT NULL DEFAULT 0,  -- 连续几封对不上
        retiredAt  TEXT,                        -- 切断实验：什么时候退的
        retireWhy  TEXT,                        -- 为什么觉得它不重要
        retirePred TEXT,                        -- 切掉之后什么该还在
        retiredVerdict TEXT,                    -- 回访结论：broke / fine / partial
        retiredNote TEXT,                       -- 回访记的那句话
        checkedAt  TEXT,                        -- 回访时间
        -- 2026-10-28 第二版：照 dsh-world 的 alarm note 思路，
        -- 「要记牢」也要求能说清「怎么算它应验了」。
        -- 为什么需要：没有可核对写法的标记**永远无法被证伪**，于是只会越标越多
        -- （实测她 5 条里有 4 条是「他先想着给我装眼睛」的不同说法）。
        -- 有 checkText 的标记，醒着的时候能把「当时标的」和「后来真发生的」摆在一起看。
        checkText  TEXT,                        -- 怎么算应验（她自己的话）
        checkState TEXT,                        -- pending / held / broke（尚未应验 / 应验了 / 没应验）
        checkAt    TEXT,                        -- 上一次核对的日期
        checkNote  TEXT,                        -- 核对时记的一句
        -- 2026-10-30：记忆分层（照 memory-brain 的 tier 设计，但 L4 的含义是我们自己的）
        --   L4 = 锚（关系/约定，永不衰减、永不归档、永不删除）
        --   L3 = 事件（90 天半衰期） / L2 = 画像（180 天） / L1 = 原子事实（30 天）
        -- 为什么必须有这一列：她的标记 strength 永远是 1（从不重复标），
        -- 没有 tier 就只能靠"被提起的时间"排序，分不出"约定"和"当天的事"。
        tier       TEXT NOT NULL DEFAULT 'L4',
        -- 最后一次被真的注入进提示词的时间（毫秒）。锚的排序用它。
        last_access INTEGER NOT NULL DEFAULT 0,
        UNIQUE(key, norm)
      );
      CREATE INDEX IF NOT EXISTS idx_covenant_marks_key ON covenant_marks(key, strength DESC);
    `)
    this.#migrate()
  }

  /** 老库升级：把 (key,day) 的旧表结构迁移到带 version 的新结构，数据一条不丢。 */
  #migrate() {
    // ── letters：旧表没有 version 列
    const letterCols = this.db.prepare('PRAGMA table_info(covenant_letters)').all().map((r) => String(r.name))
    if (!letterCols.includes('version')) {
      this.db.exec(`
        ALTER TABLE covenant_letters RENAME TO covenant_letters_old;
        CREATE TABLE covenant_letters (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          key     TEXT NOT NULL,
          day     TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          t       INTEGER NOT NULL,
          text    TEXT NOT NULL,
          supersededAt INTEGER,
          UNIQUE(key, day, version)
        );
        INSERT INTO covenant_letters(key,day,version,t,text)
          SELECT key, day, 1, t, text FROM covenant_letters_old;
        DROP TABLE covenant_letters_old;
        CREATE INDEX IF NOT EXISTS idx_covenant_letters_key_day ON covenant_letters(key, day);
      `)
    }
    // ── marks：旧表没有退役/核对那几列（ALTER 只能一列一列加）
    const markCols = this.db.prepare('PRAGMA table_info(covenant_marks)').all().map((r) => String(r.name))
    const wanted = [
      ['supported', 'INTEGER NOT NULL DEFAULT 1'],
      ['missCount', 'INTEGER NOT NULL DEFAULT 0'],
      ['retiredAt', 'TEXT'],
      ['retireWhy', 'TEXT'],
      ['retirePred', 'TEXT'],
      ['retiredVerdict', 'TEXT'],
      ['retiredNote', 'TEXT'],
      ['checkedAt', 'TEXT'],
      // 第二版：怎么算应验
      ['checkText', 'TEXT'],
      ['checkState', 'TEXT'],
      ['checkAt', 'TEXT'],
      ['checkNote', 'TEXT'],
      // 2026-10-30：分层与访问时间。老库（已有数据）补列时默认值必须是 L4 ——
      // 她现有的 9 条标记里 7 条确认是关系/承诺类，按 memory-brain 的定义就是锚。
      ['tier', "TEXT NOT NULL DEFAULT 'L4'"],
      ['last_access', 'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [name, type] of wanted) {
      if (!markCols.includes(name)) this.db.exec(`ALTER TABLE covenant_marks ADD COLUMN ${name} ${type}`)
    }

    this.#prepare()

    // ⚠️ 升级后必须把历史标记**重核一遍**。
    // ALTER ADD COLUMN 的默认值会打到所有旧行：supported 一律变成 1，
    // 而旧数据里本来就有她随手补标、信里根本没写过的句子 —— 那些会在强度榜上
    // 冒充「有依据」。这是 B 项对历史数据完全失效的那种漏洞。
    // 只在「这次才加上 supported 列」时跑（新库没有旧行，没必要）。
    if (!markCols.includes('supported')) {
      const keys = this.db.prepare('SELECT DISTINCT key FROM covenant_marks').all()
      for (const row of keys) {
        try { this.reverifyMarks(String(row.key)) } catch { /* 单会话失败不影响升级 */ }
      }
      // 没有信可核对的会话（刚装、还没写信）先全标成待查，别默认它们有依据
      this.db.exec(`
        UPDATE covenant_marks SET supported = 0
        WHERE key NOT IN (SELECT DISTINCT key FROM covenant_letters WHERE supersededAt IS NULL)
      `)
    }
  }

  #prepare() {
    this.upsertLetterStmt = this.db.prepare(`
      INSERT INTO covenant_letters(key,day,version,t,text) VALUES (?,?,?,?,?)
    `)
    this.latestVersionStmt = this.db.prepare(
      'SELECT id,version,t,text FROM covenant_letters WHERE key=? AND day=? ORDER BY version DESC LIMIT 1',
    )
    this.supersedeStmt = this.db.prepare(
      'UPDATE covenant_letters SET supersededAt=? WHERE key=? AND day=? AND supersededAt IS NULL AND id<>?',
    )
    // strength = **她标过这件事的不同天数**，不是"标了几次"。
    // 为什么：同一天她会因为补写、强调、或者桥接重放而重复标同一句；
    // 按次数算的话，一晚上重标三次就把强度顶到 3，和"连着三天都记得"混为一谈。
    // 所以同一天重复标只更新 lastDay 与文字，不涨强度（见 #addMark）。
    this.markStmt = this.db.prepare('SELECT id,strength,lastDay,retiredAt,supported FROM covenant_marks WHERE key=? AND norm=?')
    // 2026-10-30：新建时就把 last_access 写成「这一刻」。
    // ⚠️ 原来 INSERT 里没有 last_access，它落的是默认值 0，而 topMarks 用
    //   `ORDER BY last_access DESC` 排序 —— 于是**所有新标记的 last_access 都是 0**，
    //   排序的第一关键字对新标记完全没意义（实测 7 条标记的 last_access 全是同一时刻）。
    //   写入"创建时刻"之后，语义才是对的：「这条最后一次被真的提起，是它被创建的时候」。
    this.insertMarkStmt = this.db.prepare(`
      INSERT INTO covenant_marks(key,norm,text,strength,firstDay,lastDay,supported,checkText,checkState,last_access,tier)
      VALUES (?,?,?,1,?,?,?,?,?,?,?)
    `)
    // 2026-10-30：她**隔天重新标记**时同时刷新 last_access。
    // 为什么必须在这里而不是在注入时：
    //   注入时刷新会让每轮把所有标记刷成同一刻 → 9 条标记只有 2 个不同值 → 排序失效（实测）。
    //   last_access 的语义是"这条真的被她重新提起过"，这里才是真正的提起。
    // 参数顺序：text, lastDay, **last_access**, key, norm
    this.upsertMarkStmt = this.db.prepare(`
      UPDATE covenant_marks SET strength = strength + 1, text = ?, lastDay = ?, last_access = ?, supported = 1, missCount = 0
      WHERE key = ? AND norm = ?
    `)
    // 隔天再标、但这次对不上原文：**不能**把 supported 刷回 1，
    // 只涨强度会让她「越记越牢」的恰好是一条信里已经没有的话。
    // ⚠️ 2026-10-30：这里同样要写 last_access。
    //   「隔天又标了一次、只是对不上原文」依然是**她真的又提起了一次** ——
    //   supported 该保持 0（不能因为又提一次就把"没依据"洗白），
    //   但排序依据跟着前进才对。原来漏了这句，实测跨天重标后 lastAccess 原地不动。
    //   参数顺序：text, lastDay, **last_access**, key, norm
    this.upsertMarkUnsupportedStmt = this.db.prepare(`
      UPDATE covenant_marks SET strength = strength + 1, text = ?, lastDay = ?, last_access = ?,
             supported = 0, missCount = missCount + 1
      WHERE key = ? AND norm = ?
    `)
    // 同一天重标：文字刷新 + **last_access 也刷新** ——
    // 「今天又想了一遍」确实是"被真的提起"，强度不涨（那要跨天），但排序依据该跟着走。
    this.touchMarkStmt = this.db.prepare('UPDATE covenant_marks SET text = ?, last_access = ? WHERE key = ? AND norm = ?')
    // 退役后她又标了一次 = 她自己反悔：撤销退役、把结论记成 broke（切早了），重新计入现行。
    // retireWhy/retirePred 不清空 —— 那是历史，记着「我当初为什么想切掉它」。
    this.reinstateStmt = this.db.prepare(`
      UPDATE covenant_marks
      SET retiredAt = NULL, retiredVerdict = 'broke', checkedAt = ?,
          retiredNote = COALESCE(retiredNote, '后来又标了一次 —— 切断切早了，这条回来了')
      WHERE key = ? AND norm = ?
    `)
    this.missStmt = this.db.prepare('UPDATE covenant_marks SET supported = 0, missCount = missCount + 1 WHERE key = ? AND norm = ?')
    // 写/改「怎么算应验」，并重置为待核对
    this.setCheckStmt = this.db.prepare('UPDATE covenant_marks SET checkText = ?, checkState = ? WHERE key = ? AND norm = ?')
    // ⚠ 过滤必须写在 SQL 里，不能"取一批行再在 JS 里丢掉"（2026-10-29 修的真 bug）：
    //   ORDER BY strength DESC 会让**已退役**的高强度老标记排在最前，而退役不改 strength。
    //   原来取 limit*4=20 行再 continue 掉退役/孤儿，库大了之后前 20 行全被退役标记占满，
    //   现行标记被挤出 → 【契阔·你标过要记牢的】整段静默消失（不报错、不写日志）。
    //   实测：25 条退役高强度标记就能让 topMarks(5) 返回 0 条。
    //   现在 retiredAt 无条件在 SQL 里排除；孤儿按 ? 开关（includeUnsupported）决定。
    // 2026-10-30：加 tier / last_access。
    //   tier：L4=锚（永不衰减）、L3/L2/L1 按半衰期衰减（见 scripts/decay-memory.mjs）
    //   last_access：这条最后一次被「真的提起」的时间，锚的排序用它
    //     —— 原实现只按 strength DESC，而她的 strength 永远是 1（从不重复标），
    //        等于没有排序依据，新标记会被旧标记挤在后面。
    this.marksAllStmt = this.db.prepare(
      `SELECT norm,text,strength,firstDay,lastDay,supported,missCount,retiredAt,retireWhy,retirePred,
              retiredVerdict,retiredNote,checkedAt,checkText,checkState,checkAt,checkNote,
              COALESCE(tier,'L4') AS tier, COALESCE(last_access,0) AS last_access
       FROM covenant_marks
       WHERE key=? AND retiredAt IS NULL AND (? = 1 OR supported = 1)
       ORDER BY last_access DESC, strength DESC, lastDay DESC LIMIT ?`,
    )
  }

  /**
   * 写入一封（**只加不改**）。
   *
   * 同一天再写：
   *   · 正文一字不差 → 什么都不做（幂等；桥接每次启动都会重放）
   *   · 正文变了     → 存成 version+1，旧版标 supersededAt（不删）
   *
   * @returns {true|false|undefined} true=新的一版 / false=只在旧信上补了标记 / undefined=完全没变
   */
  saveLetter({ key, day, text, marks = [], t = Date.now(), source = 'memory' }) {
    const clean = String(text ?? '').trim()
    if (!clean) return undefined
    const latest = this.latestVersionStmt.get(String(key), String(day))
    if (latest && String(latest.text) === clean) {
      // 正文没变：只可能补了标记
      let added = 0
      for (const m of marks) {
        const { text: mText, check: mCheck } = splitMark(m)
        const norm = normalizeMarkText(mText)
        if (!norm) continue
        if (this.markStmt.get(String(key), norm)) continue
        this.#addMark(key, mText, day, clean, mCheck)
        added += 1
      }
      return added > 0 ? false : undefined
    }
    const version = latest ? Number(latest.version) + 1 : 1
    const info = this.upsertLetterStmt.run(String(key), String(day), version, Number(t), clean)
    // 旧版保留，只标记被取代 —— 这就是「只加不改」
    this.supersedeStmt.run(Number(t), String(key), String(day), Number(info.lastInsertRowid))
    for (const m of marks) {
      const { text: mText, check: mCheck } = splitMark(m)
      this.#addMark(key, mText, day, clean, mCheck)
    }
    return true
  }

  #addMark(key, text, day, letterText, check = '', tier = 'L4') {
    const norm = normalizeMarkText(text)
    if (!norm) return
    const clean = String(text).trim().slice(0, 200)
    // 只认这四个层级；传错/不传一律按 L4（锚）。
    const tierSafe = ['L1', 'L2', 'L3', 'L4'].includes(String(tier).toUpperCase()) ? String(tier).toUpperCase() : 'L4'
    // B 项：标记必须能在当天的信里对上原句（照它的「证据指针」）。
    // 没有信可核对（她直接调工具补标）时**不算对上** —— 没有依据的标记就是孤儿，
    // 等它真的出现在某天的信里再自动转正（见 reverifyMarks）。
    const supported = letterText === undefined ? 0 : (markSupportedBy(letterText, clean) ? 1 : 0)
    const existing = this.markStmt.get(String(key), norm)
    if (!existing) {
      this.insertMarkStmt.run(String(key), norm, clean, String(day), String(day), supported, check || null, check ? 'pending' : null, Date.now(), tierSafe)
      return
    }
    // 已退役的标记又被她标了一次 —— 这是**她自己反悔**，不是要复活的 bug。
    // 但也不能静默：永久忽略等于「她说了不算」。照它 seal_later 的双轨（站住了/塌了），
    // 这里处理成「退役结论改判为 broke：切断之后那东西又回来了，说明当时切早了」，
    // 并**重新计入现行**（她既然还想着它，它就该在榜单上）。
    // retireWhy/retirePred 原样留着当历史 —— 那就是「只加不改」。
    if (existing.retiredAt) {
      this.reinstateStmt.run(localStamp(), String(key), norm)
      this.touchMarkStmt.run(clean, Date.now(), String(key), norm)
      if (supported) this.upsertMarkStmt.run(clean, String(day), Date.now(), String(key), norm)
      else this.upsertMarkUnsupportedStmt.run(clean, String(day), Date.now(), String(key), norm)
      return
    }
    // 她这次写了「怎么算应验」而原来没有 → 补上，并回到 pending（待核对）
    if (check) this.setCheckStmt.run(String(check).trim().slice(0, 300), 'pending', String(key), norm);

    // 同一天已标过：只刷新文字，强度不变（否则一晚上重标三次就等于三天都记得）
    if (String(existing.lastDay) === String(day)) {
      this.touchMarkStmt.run(clean, Date.now(), String(key), norm)
      if (!supported) this.missStmt.run(String(key), norm)
      return
    }
    if (supported) this.upsertMarkStmt.run(clean, String(day), Date.now(), String(key), norm)
    else this.upsertMarkUnsupportedStmt.run(clean, String(day), Date.now(), String(key), norm)
  }

  /**
   * 她直接调工具补标（不经过信）也能用；此时无法核对原文，标记为 unsupported 待查。
   *
   * @param {string} [tier] 记忆层级：L4=锚（永不衰减，默认）/ L3=事件(90天) / L2=画像(180天) / L1=事实(30天)
   *
   * ⚠️ 2026-10-30：以前**没有任何地方能写 tier**，全都落默认值 L4，
   *   于是 decay-memory.mjs 的 HALF_LIFE（L1=30/L2=180/L3=90）整段是死代码。
   *   现在参数化，但**默认仍然是 L4** —— 她的标记几乎全是关系/约定类，
   *   按 memory-brain 的定义本来就该是锚。要不要降级是她的判断，不是代码的判断。
   */
  addMark(key, text, day = localDay(), tier = 'L4') {
    this.#addMark(key, text, day, undefined, '', tier)
  }

  /**
   * 重新核对现行标记：这条标记还能不能在某封信里找到依据。
   *
   * ⚠️ 这里踩过一个真 bug（2026-10-28 自己查出来的，比上线还严重）：
   * 头一版只拿「当时的 day」那封信去核对**全部**标记。结果是 —— 她第二天正常写一封
   * 新信（里面当然没有昨天那句话），`reverifyMarks(key, 今天)` 就把昨天所有标记
   * 判成「对不上原文」，强度榜瞬间清空。**每天都会清一遍**，等于这套机制根本不能用。
   *
   * 正确的范围：一条标记只要在**任意一封现存信**里能找到依据，它就还算数。
   * 依据来自「她当初写它的那一天」，不是「今天那封信」。
   * 传 day 只用于：优先在该天的信里找（她当天改信后立刻生效），其余按最近的信兜底。
   *
   * @returns {{checked:number, missing:string[]}}
   */
  reverifyMarks(key, day = '') {
    const rows = this.db.prepare(
      'SELECT id,norm,text,supported FROM covenant_marks WHERE key=? AND retiredAt IS NULL',
    ).all(String(key))
    if (!rows.length) return { checked: 0, missing: [] }
    // 只取现行版本（被取代的旧版不算依据 —— 否则她删掉的句子靠旧版永远"有依据"）
    const letters = this.db.prepare(
      'SELECT day,version,text FROM covenant_letters WHERE key=? AND supersededAt IS NULL',
    ).all(String(key))
    if (!letters.length) return { checked: rows.length, missing: [] }
    // 当天优先（她刚改完信就重核），其余按日期倒序
    letters.sort((a, b) => {
      if (String(a.day) === String(day)) return -1
      if (String(b.day) === String(day)) return 1
      return String(b.day).localeCompare(String(a.day))
    })
    const missing = []
    const revive = this.db.prepare('UPDATE covenant_marks SET supported = 1, missCount = 0 WHERE key=? AND norm=?')
    for (const row of rows) {
      const hit = letters.some((l) => markSupportedBy(String(l.text), String(row.text)))
      if (hit) {
        // 她后来又把这句话写回去了 → 标记重新有依据（孤儿是状态，不是判决）
        if (Number(row.supported) === 0) revive.run(String(key), String(row.norm))
        continue
      }
      if (Number(row.supported) === 1) this.missStmt.run(String(key), String(row.norm))
      missing.push(String(row.text))
    }
    return { checked: rows.length, missing }
  }

  latestLetter(key) {
    const row = this.db.prepare(
      'SELECT day,version,t,text FROM covenant_letters WHERE key=? ORDER BY day DESC, version DESC LIMIT 1',
    ).get(String(key))
    return row ? { day: String(row.day), version: Number(row.version), t: Number(row.t), text: String(row.text) } : null
  }

  /** 最近几封信（每天只取最新一版）。 */
  letters(key, limit = 7) {
    return this.db.prepare(
      `SELECT day,MAX(version) AS version,MAX(t) AS t,
              (SELECT text FROM covenant_letters c2
                WHERE c2.key=c1.key AND c2.day=c1.day ORDER BY version DESC LIMIT 1) AS text
       FROM covenant_letters c1 WHERE key=? GROUP BY day ORDER BY day DESC LIMIT ?`,
    ).all(String(key), Math.max(1, Math.min(60, Number(limit) || 7))).map((r) => ({
      day: String(r.day), version: Number(r.version), t: Number(r.t), text: String(r.text),
    }))
  }

  /** 某一天的所有版本（「只加不改」的账本，按版本升序）。 */
  letterVersions(key, day) {
    return this.db.prepare(
      'SELECT version,t,text,supersededAt FROM covenant_letters WHERE key=? AND day=? ORDER BY version ASC',
    ).all(String(key), String(day)).map((r) => ({
      version: Number(r.version),
      t: Number(r.t),
      text: String(r.text),
      supersededAt: r.supersededAt == null ? null : Number(r.supersededAt),
    }))
  }

  /** 现行（未退役）的「要记牢的」，按强度排；默认只看对得上原文的。 */
  topMarks(key, limit = 5, { includeUnsupported = false } = {}) {
    // ⚠ 必须取整：SQLite 的 `LIMIT ?` 收到小数会直接抛 "datatype mismatch"，
    // 而旧实现（取一批行再在 JS 里按 out.length >= 2.5 截断）对小数是容忍的。
    // 换句话说，不取整就等于把一个以前能跑的调用变成硬报错。
    const want = Math.min(50, Math.max(1, Math.round(Number(limit)) || 5))
    // 过滤在 SQL 里做（见构造函数里 marksAllStmt 的注释）：
    //   retiredAt 恒排除；supported 由 includeUnsupported 决定。
    // 所以取回的前 want 行**就是**要的结果，不再需要"取 4 倍行数来抵消过滤损耗"。
    // 下面循环里的两个 continue 只是防御（SQL 已经保证），保留是为了万一
    // 以后有人把过滤条件改回去时不会静默放过退役标记。
    // ⚠ node:sqlite **不接受布尔值绑参**（会抛 "Provided value cannot be bound to SQLite
    // parameter"）。所以这里显式转成 0/1 —— 别把 includeUnsupported 直接传进去。
    const flag = includeUnsupported === true ? 1 : 0
    const rows = this.marksAllStmt.all(String(key), flag, want)
    const out = []
    for (const r of rows) {
      if (r.retiredAt) continue
      if (!includeUnsupported && Number(r.supported) === 0) continue
      out.push({
        norm: String(r.norm), text: String(r.text), strength: Number(r.strength),
        firstDay: String(r.firstDay), lastDay: String(r.lastDay),
        supported: Number(r.supported) === 1, missCount: Number(r.missCount) || 0,
        // 「怎么算应验」：没有就是 null —— 她自己知道这条没法核对
        check: r.checkText == null ? null : String(r.checkText),
        checkState: r.checkState == null ? null : String(r.checkState),
        checkAt: r.checkAt == null ? null : String(r.checkAt),
        checkNote: r.checkNote == null ? null : String(r.checkNote),
        tier: String(r.tier ?? 'L4'),
        lastAccess: Number(r.last_access) || 0,
      })
      if (out.length >= want) break
    }
    return out
  }

  /**
   * 核对一条「要记牢」：当初她的说法，后来应验了吗。
   *
   * 照 dsh-world 的 alarm note 思路：到点时把「许的愿」和「实际发生的事」摆在一起，
   * 光凭记忆说「我觉得它还是挺重要的」不作数。
   *
   * @param state held=应验了 / broke=没应验 / pending=还是说不准（回到待核对）
   * @returns {{ok:boolean, error?:string, mark?:object}}
   */
  checkMark({ key, text, state, note, now = Date.now() }) {
    const norm = normalizeMarkText(text)
    if (!norm) return { ok: false, error: '不知道要核对哪一条（空）' }
    const s = String(state ?? '').trim()
    if (!['held', 'broke', 'pending'].includes(s)) {
      return { ok: false, error: 'state 必须是 held（应验了）/ broke（没应验）/ pending（还说不准）' }
    }
    const row = this.db.prepare('SELECT text,retiredAt,checkText FROM covenant_marks WHERE key=? AND norm=?').get(String(key), norm)
    if (!row) return { ok: false, error: '没有这条标记 —— 先确认是哪一件（用 qq_covenant_read 查）' }
    if (row.retiredAt) return { ok: false, error: '这条已经退役了，不用再核对' }
    // 2026-10-28 改：不再因为「她没写核对办法」就拒绝。
    //
    // 理由来自 dsh-world 的做法 —— 它的 note 从不校验质量，因为**判据不由她写**，
    // 由插件从活动日志里数出来，到点把「她说的」和「实际发生的」摆在一起（contradict）。
    // 我们照搬：她现在即使没写 checkText，也照样能标记「应验 / 没应验」，
    // 依据是注入里那几行「他后来又提到 N 次」——那是桥接数的，她改不了。
    // 强行要求她先写判据，只会把日记逼成任务清单。
    if (!row.checkText) {
      this.db.prepare(
        'UPDATE covenant_marks SET checkState=?, checkAt=?, checkNote=? WHERE key=? AND norm=?',
      ).run(s, localDay(now), String(note ?? '').trim().slice(0, 300) || '（依据：桥接统计的事实）', String(key), norm)
      return { ok: true, mark: { text: String(row.text), state: s, check: null }, noCheckText: true }
    }
    this.db.prepare(
      'UPDATE covenant_marks SET checkState=?, checkAt=?, checkNote=? WHERE key=? AND norm=?',
    ).run(s, localDay(now), String(note ?? '').trim().slice(0, 300) || null, String(key), norm)
    return { ok: true, mark: { text: String(row.text), state: s, check: String(row.checkText) } }
  }

  /** 有「怎么算应验」但还挂着待核对的（该提醒她核了）。 */
  pendingChecks(key, limit = 10, { olderThanDay = '' } = {}) {
    const rows = this.db.prepare(
      `SELECT norm,text,strength,checkText,checkState,checkAt,lastDay FROM covenant_marks
       WHERE key=? AND retiredAt IS NULL AND checkText IS NOT NULL
         AND (checkState IS NULL OR checkState='pending')
       ORDER BY strength DESC, lastDay DESC LIMIT ?`,
    ).all(String(key), Math.max(1, Math.min(50, Number(limit) || 10)))
    return rows
      .filter((r) => !olderThanDay || String(r.lastDay) < olderThanDay)
      .map((r) => ({
        norm: String(r.norm), text: String(r.text), strength: Number(r.strength),
        check: String(r.checkText), state: r.checkState == null ? 'pending' : String(r.checkState),
        checkAt: r.checkAt == null ? null : String(r.checkAt), lastDay: String(r.lastDay),
      }))
  }

  /** 对不上原文、还没退役的标记（B 项的产出：该她自己看一眼了）。 */
  unsupportedMarks(key, limit = 10) {
    return this.db.prepare(
      `SELECT norm,text,strength,firstDay,lastDay,missCount FROM covenant_marks
       WHERE key=? AND retiredAt IS NULL AND supported=0 ORDER BY missCount DESC, strength DESC LIMIT ?`,
    ).all(String(key), Math.max(1, Math.min(50, Number(limit) || 10))).map((r) => ({
      norm: String(r.norm), text: String(r.text), strength: Number(r.strength),
      firstDay: String(r.firstDay), lastDay: String(r.lastDay), missCount: Number(r.missCount) || 0,
    }))
  }

  /** 已退役（切断实验）的标记，含 为什么退 / 预测什么该还在 / 事后怎么判的。 */
  retiredMarks(key, limit = 20) {
    return this.db.prepare(
      `SELECT norm,text,strength,firstDay,lastDay,retiredAt,retireWhy,retirePred,retiredVerdict,retiredNote,checkedAt
       FROM covenant_marks WHERE key=? AND retiredAt IS NOT NULL ORDER BY retiredAt DESC LIMIT ?`,
    ).all(String(key), Math.max(1, Math.min(100, Number(limit) || 20))).map((r) => ({
      norm: String(r.norm), text: String(r.text), strength: Number(r.strength),
      firstDay: String(r.firstDay), lastDay: String(r.lastDay),
      retiredAt: String(r.retiredAt), why: String(r.retireWhy ?? ''), pred: String(r.retirePred ?? ''),
      verdict: r.retiredVerdict == null ? null : String(r.retiredVerdict),
      note: r.retiredNote == null ? null : String(r.retiredNote),
      checkedAt: r.checkedAt == null ? null : String(r.checkedAt),
    }))
  }

  /** 退役还没回访的（切断实验欠着「后来」）。 */
  retiredUnsettled(key, limit = 10) {
    return this.db.prepare(
      `SELECT norm,text,retiredAt,retireWhy,retirePred FROM covenant_marks
       WHERE key=? AND retiredAt IS NOT NULL AND retiredVerdict IS NULL ORDER BY retiredAt DESC LIMIT ?`,
    ).all(String(key), Math.max(1, Math.min(50, Number(limit) || 10))).map((r) => ({
      norm: String(r.norm), text: String(r.text), retiredAt: String(r.retiredAt),
      why: String(r.retireWhy ?? ''), pred: String(r.retirePred ?? ''),
    }))
  }

  /**
   * 退役（切断实验第一步）：**不删**，改状态 + 记下理由与预测。
   * @returns {{ok:boolean, problems:string[], text?:string}}
   */
  retireMark({ key, text, why, pred, now = Date.now() }) {
    const norm = normalizeMarkText(text)
    if (!norm) return { ok: false, problems: ['不知道要退役哪一条（空）'] }
    const check = checkRetireReason({ why, pred })
    const row = this.db.prepare('SELECT text,retiredAt FROM covenant_marks WHERE key=? AND norm=?').get(String(key), norm)
    if (!row) return { ok: false, problems: ['没有这条标记 —— 先确认是哪一件（用 qq_covenant_read 查）'] }
    if (row.retiredAt) return { ok: false, problems: [`这条已经退役过了（${String(row.retiredAt)}），不重复切`] }
    if (!check.ok) return check
    this.db.prepare(
      'UPDATE covenant_marks SET retiredAt=?, retireWhy=?, retirePred=? WHERE key=? AND norm=?',
    ).run(localStamp(now), String(why).trim().slice(0, 300), String(pred).trim().slice(0, 300), String(key), norm)
    return { ok: true, problems: [], text: String(row.text) }
  }

  /** 切断实验第三步（回访）：切掉之后塌了还是没事。 */
  settleRetired({ key, text, verdict, note, now = Date.now() }) {
    const norm = normalizeMarkText(text)
    const v = ['broke', 'fine', 'partial'].includes(String(verdict)) ? String(verdict) : null
    if (!v) return { ok: false, error: 'verdict 必须是 broke（塌了/确实少东西）/ fine（没事）/ partial（有点影响）' }
    if (String(note ?? '').trim().length < 4) return { ok: false, error: 'note 不能为空：只写「塌了/没事」不是结果，是情绪' }
    const row = this.db.prepare('SELECT retiredAt,retiredVerdict,retiredNote FROM covenant_marks WHERE key=? AND norm=?').get(String(key), norm)
    if (!row) return { ok: false, error: '没有这条标记' }
    if (!row.retiredAt) return { ok: false, error: '这条还没退役，先 retire 再回访' }
    // 已经回访过还能再回访（过一阵看法会变），但**不覆盖**上一次 ——
    // 照它的「只加不改」：新结论追加在后面，旧的那句留着。
    // 覆盖掉的话，你就再也看不见「我当初以为它没事」了。
    let noteText = String(note).trim().slice(0, 300)
    let mergedVerdict = v
    if (row.retiredVerdict) {
      const prev = `${String(row.retiredVerdict)}：${String(row.retiredNote ?? '')}`
      noteText = `${prev} ／ 后来（${localStamp(now)}）${v}：${noteText}`.slice(0, 600)
      // 结论取最新的，但前面那句留着
      mergedVerdict = v
    }
    this.db.prepare(
      'UPDATE covenant_marks SET retiredVerdict=?, retiredNote=?, checkedAt=? WHERE key=? AND norm=?',
    ).run(mergedVerdict, noteText, localStamp(now), String(key), norm)
    return { ok: true, verdict: v, appended: !!row.retiredVerdict }
  }

  /**
   * 标记「刚被真的提起过」（更新 last_access）。
   *
   * 为什么只对真正注入的那几条调用（不是对检索到的全部）：
   *   照抄 memory-brain store.py:667-694 的"频率感知"思路 —— 被访问过的减半衰减、
   *   归档时豁免。但如果对候选集全量强化，那些根本没进提示词的也涨了，
   *   等于把噪声也当成"重要"，一年后所有标记一样重。
   *
   * 失败静默：这只影响排序权重，不该影响注入本身。
   */
  touchMarkAccess(key, norms, now = Date.now()) {
    try {
      const list = (Array.isArray(norms) ? norms : []).filter((x) => typeof x === 'string' && x);
      if (!list.length) return 0;
      const stmt = this.db.prepare('UPDATE covenant_marks SET last_access=? WHERE key=? AND norm=?')
      let n = 0
      for (const norm of list) n += Number(stmt.run(Number(now), String(key), norm).changes) || 0
      return n
    } catch {
      return 0
    }
  }

  /** 现行标记数：未退役**且**有依据的（和 topMarks 默认口径一致）。 */
  markCount(key) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM covenant_marks WHERE key=? AND retiredAt IS NULL AND supported=1',
    ).get(String(key))
    return Number(row?.n ?? 0)
  }

  /**
   * 在旧信里检索。中文短词用 LIKE（trigram 按 3 字切，两字词进不了索引 —— 与 recall.mjs 同一个坑）。
   * @returns {{day:string,version:number,text:string,hits:number}[]}
   */
  searchLetters({ key, tokens = [], limit = 1, before = Date.now() } = {}) {
    const terms = [...new Set((tokens ?? []).filter((x) => x && String(x).length >= 2))].slice(0, 8)
    if (!terms.length) return []
    const cand = new Map()
    for (const term of terms) {
      const rows = this.db.prepare(
        `SELECT id,day,version,t,text FROM covenant_letters
         WHERE key=? AND t<? AND text LIKE ? AND supersededAt IS NULL
         ORDER BY t DESC LIMIT 200`,
      ).all(String(key), Number(before) || Date.now(), `%${term}%`)
      for (const row of rows) cand.set(row.id, row)
    }
    const scored = []
    for (const row of cand.values()) {
      const text = String(row.text ?? '')
      let hits = 0
      for (const term of terms) if (text.includes(term)) hits += 1
      if (hits <= 0) continue
      scored.push({ day: String(row.day), version: Number(row.version), t: Number(row.t), text, hits })
    }
    scored.sort((a, b) => b.hits - a.hits || b.t - a.t)
    return scored.slice(0, Math.max(1, Math.min(10, Number(limit) || 1)))
  }

  close() {
    try { this.db.close() } catch { /* ignore */ }
  }
}
