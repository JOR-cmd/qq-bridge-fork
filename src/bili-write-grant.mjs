// B 站写操作的授权闸门（框架，当前不执行任何写入）。
//
// 设计来自 InariNGT-Ofiicial/dsh-bili-humanism 的 lib/writer.mjs，照搬它的四层结构：
//   ① 配置开关（代码级）      enableXxxWrites
//   ② 本地授权文件            { enabled, handoverConfirmed, expiresAt, videos, maxWrites }
//   ③ 每次写前重读 + 指纹比对  授权改了 / 凭据换了 → 立刻失效
//   ④ 写入后读回验证          结果不一致 → 进入「未知结果」暂停，等人工确认
//
// ⚠️ 与它的一处关键差异，也是这个项目最硬的一条：
//   **写入类型里没有 comment / reply / dm 这几个名字**（见 WRITABLE_KINDS）。
//   不是「默认关闭」，是**枚举里不存在** —— 想加评论必须先改这个数组，
//   而那一步改的是「这个项目允许做什么」这件事本身，应该被人看见。
//
// 它用 bili_jct 做 CSRF；本项目**永不索取 bili_jct**，所以即便这里放行，
// 真实写入也会被平台以 `-111 CSRF 校验失败` 拒绝。这是双保险。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** 允许的写入类型。**故意不含 comment / reply / dm** —— 见文件头说明。 */
export const WRITABLE_KINDS = Object.freeze(['likes', 'favorites', 'coins'])

/** 配置开关名，照它的命名。 */
export const SWITCH_NAMES = Object.freeze({
  likes: 'enableLikeWrites',
  favorites: 'enableFavoriteWrites',
  coins: 'enableCoinWrites',
})

/** 每种写入的参数白名单（防「顺手多传一个参数」扩大行为）。 */
const ALLOWED_ARGS = Object.freeze({
  likes: ['bvid'],
  favorites: ['bvid', 'folderId', 'action'],
  coins: ['bvid', 'totalCoins'],
})

const LIMITS = Object.freeze({
  minGapMs: 60_000,      // 两次写至少隔 60 秒（它的 WRITE_RATE_LIMIT）
  maxWritesPerKind: 100, // 单类总次数上限
  maxVideos: 100,        // 授权文件里最多列多少个视频
  maxCoins: 200,         // 投币总预算上限
  maxCoinsPerVideo: 2,
})

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')

function readJson(file, fallback) {
  try {
    const s = fs.readFileSync(file, 'utf8')
    if (s.length > 65536) throw new Error('too large')
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 空授权模板：写出来给你改，默认全关。 */
export function emptyGrant(accountId = '', note = '') {
  return {
    version: 1,
    id: `local-grant-${Date.now()}`,
    enabled: false,
    handoverConfirmed: false,
    accountId: String(accountId || ''),
    expiresAt: '2000-01-01T00:00:00Z',
    allVideos: false,
    videos: [],
    likes: { enabled: false, maxWrites: 10 },
    favorites: { enabled: false, maxWrites: 10, folders: [] },
    coins: { enabled: false, maxWrites: 10, maxCoins: 20, maxPerVideo: 1 },
    note,
  }
}

/** 读取并校验授权文件；任何一处不合法都返回 invalid（**不抛错**，让调用方能给出可读原因）。 */
export function loadGrant(grantPath) {
  if (!grantPath || !fs.existsSync(grantPath)) {
    return { ok: false, code: 'GRANT_FILE_MISSING', grant: null }
  }
  const g = readJson(grantPath, null)
  if (!g || typeof g !== 'object') return { ok: false, code: 'GRANT_INVALID', grant: null }

  const problems = []
  if (g.version !== 1) problems.push('version 必须是 1')
  if (typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(g.id)) problems.push('id 非法')
  if (g.enabled !== true) problems.push('enabled 不是 true')
  if (g.handoverConfirmed !== true) problems.push('handoverConfirmed 不是 true（需本人确认有权管理该账号）')
  if (!/^\d{1,16}$/.test(String(g.accountId ?? ''))) problems.push('accountId 必须是纯数字')

  const exp = Date.parse(String(g.expiresAt ?? ''))
  if (!Number.isFinite(exp)) problems.push('expiresAt 不是合法时间')
  else if (exp <= Date.now()) problems.push(`授权已过期（${new Date(exp).toISOString()}）`)

  if (!g.allVideos) {
    if (!Array.isArray(g.videos) || g.videos.length === 0) problems.push('videos 为空且 allVideos 不是 true')
    else if (g.videos.length > LIMITS.maxVideos) problems.push(`videos 超过 ${LIMITS.maxVideos} 个`)
    else if (!g.videos.every((v) => /^BV[0-9A-Za-z]{10}$/.test(String(v)))) problems.push('videos 里有非 BV 号')
  }

  for (const kind of WRITABLE_KINDS) {
    const s = g[kind]
    if (!s || typeof s !== 'object') { problems.push(`${kind} 段缺失`); continue }
    const max = Number(s.maxWrites)
    if (!Number.isInteger(max) || max < 1 || max > LIMITS.maxWritesPerKind) {
      problems.push(`${kind}.maxWrites 必须是 1~${LIMITS.maxWritesPerKind}`)
    }
  }

  if (g.coins) {
    const total = Number(g.coins.maxCoins)
    const per = Number(g.coins.maxPerVideo)
    if (!Number.isInteger(total) || total < 1 || total > LIMITS.maxCoins) problems.push('coins.maxCoins 越界')
    if (![1, 2].includes(per)) problems.push('coins.maxPerVideo 只能是 1 或 2')
  }

  if (problems.length) return { ok: false, code: 'GRANT_INVALID', problems, grant: g }
  return { ok: true, code: 'GRANT_OK', grant: g, fingerprint: sha(g) }
}

/**
 * 判断一次写入是否被允许。**只做判断，不执行写入。**
 *
 * @param {object} opts
 * @param {'likes'|'favorites'|'coins'} opts.kind
 * @param {object} opts.args             写操作参数（只认白名单里的键）
 * @param {string} opts.bvid
 * @param {object} opts.config           宿主配置（含 enableXxxWrites 开关）
 * @param {string} opts.grantPath
 * @param {string} opts.usagePath        次数/时间戳的持久化文件
 * @param {number} [opts.now]
 * @returns {{allowed:boolean, code:string, reason?:string, plan?:object}}
 */
export function checkWriteAllowed({
  kind,
  args = {},
  bvid,
  config = {},
  grantPath,
  usagePath,
  now = Date.now(),
} = {}) {
  // ① 类型必须在枚举内 —— comment/reply/dm 在这里直接被拒（它们根本不在 WRITABLE_KINDS 里）
  if (!WRITABLE_KINDS.includes(kind)) {
    return { allowed: false, code: 'WRITE_KIND_DENIED', reason: `类型 ${kind} 不在允许清单内（本项目不支持评论/私信）` }
  }

  // ② 参数不能多余
  const extra = Object.keys(args).filter((k) => !ALLOWED_ARGS[kind].includes(k))
  if (extra.length) return { allowed: false, code: 'UNKNOWN_PARAMETER', reason: `多余参数：${extra.join(', ')}` }

  // ③ 配置开关
  const switchName = SWITCH_NAMES[kind]
  if (config?.[switchName] !== true) {
    return { allowed: false, code: 'WRITE_DISABLED', reason: `${switchName} 未开启` }
  }

  // ④ 授权文件
  const loaded = loadGrant(grantPath)
  if (!loaded.ok) {
    return { allowed: false, code: loaded.code, reason: (loaded.problems ?? []).join('；') || loaded.code }
  }
  const g = loaded.grant
  if (g[kind]?.enabled !== true) return { allowed: false, code: 'WRITE_SCOPE_DENIED', reason: `授权里 ${kind} 未开启` }

  // ⑤ 目标视频必须在白名单里
  if (!g.allVideos && !g.videos.includes(bvid)) {
    return { allowed: false, code: 'WRITE_TARGET_DENIED', reason: `视频 ${bvid} 不在授权名单内` }
  }

  // ⑥ 次数、间隔、投币预算（持久化在 usagePath）
  const usage = readJson(usagePath, {}) || {}
  const kindKey = `quota:${g.id}:${kind}`
  const used = Number(usage[kindKey] ?? 0)
  const limit = Number(g[kind].maxWrites)
  if (used >= limit) return { allowed: false, code: 'WRITE_QUOTA_EXCEEDED', reason: `已用 ${used}/${limit} 次` }

  const lastTs = Number(usage['write:last'] ?? 0)
  if (now - lastTs < LIMITS.minGapMs) {
    const waitS = Math.ceil((LIMITS.minGapMs - (now - lastTs)) / 1000)
    return { allowed: false, code: 'WRITE_RATE_LIMIT', reason: `还需等 ${waitS} 秒` }
  }

  if (kind === 'coins') {
    const budgetKey = `coins:${g.id}`
    const spent = Number(usage[budgetKey] ?? 0)
    const want = Number(args.totalCoins ?? 1)
    if (!Number.isInteger(want) || want < 1 || want > Number(g.coins.maxPerVideo)) {
      return { allowed: false, code: 'COIN_AMOUNT_DENIED', reason: `单次投币数必须是 1~${g.coins.maxPerVideo}` }
    }
    if (spent + want > Number(g.coins.maxCoins)) {
      return { allowed: false, code: 'COIN_BUDGET_EXCEEDED', reason: `预算 ${spent + want}/${g.coins.maxCoins}` }
    }
  }

  return {
    allowed: true,
    code: 'WRITE_ALLOWED',
    plan: {
      kind,
      bvid,
      args,
      grantId: g.id,
      grantFingerprint: loaded.fingerprint,
      remainingAfter: limit - used - 1,
      // 注意：本项目**没有** bili_jct，所以这里即便 allowed 也发不出去。
      // 真要落地，必须由使用者显式提供写凭据 —— 那是另一件需要当面决定的事。
      credentialForWrite: 'absent (by design: 本项目不索取 bili_jct)',
    },
  }
}

/** 记录一次已成功的写入（由将来的执行器在**读回验证通过后**调用）。 */
export function recordWrite({ kind, grant, usagePath, now = Date.now() } = {}) {
  if (!WRITABLE_KINDS.includes(kind)) throw new Error(`类型 ${kind} 不允许`)
  const usage = readJson(usagePath, {}) || {}
  const kindKey = `quota:${grant.id}:${kind}`
  usage[kindKey] = Number(usage[kindKey] ?? 0) + 1
  usage['write:last'] = now
  if (kind === 'coins') {
    const budgetKey = `coins:${grant.id}`
    usage[budgetKey] = Number(usage[budgetKey] ?? 0) + 1
  }
  writeJson(usagePath, usage)
  return usage
}

/** 状态摘要（给控制台/日志看）。 */
export function writeStatus({ grantPath, usagePath } = {}) {
  const loaded = loadGrant(grantPath)
  const usage = readJson(usagePath, {}) || {}
  const result = {
    writableKinds: [...WRITABLE_KINDS],
    forbiddenByDesign: ['comment', 'reply', 'dm', 'dynamic'],
    grant: loaded.ok
      ? { id: loaded.grant.id, expiresAt: loaded.grant.expiresAt, allVideos: loaded.grant.allVideos }
      : { state: loaded.code, problems: loaded.problems ?? [] },
    usage: Object.fromEntries(Object.entries(usage).filter(([k]) => k.startsWith('quota:') || k.startsWith('coins:') || k === 'write:last')),
  }
  return result
}
