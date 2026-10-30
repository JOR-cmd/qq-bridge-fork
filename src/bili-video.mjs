// B 站分享视频 → 画面帧 + 弹幕 + 评论，供桥接在收到卡片/链接时注入上下文。
//
// 设计原则（和 dsh-bili-humanism 的区别）：
//   · 用它不看的东西：弹幕（观众在某一秒的反应）与热门评论
//   · 抽帧用 ffmpeg 命令行（本机已装、已验证），不引 Python/PyAV
//   · 产出只进「这一条消息的上下文」，不写人格文件，不改安全边界
//
// 不做的事（明确写死，避免以后「顺手加上」）：
//   · 不登录、不带 cookie、不写任何平台状态
//   · 不下载整段视频：按 Range 只取头部（抽帧够用就停）
//   · 不做 ASR（本地转写要 1 GB 模型，与本机定位不符）
import { execFileSync } from 'node:child_process'
import { framesFromStoryboard } from './bili-storyboard.mjs'
import { resolveVideoByTitle } from './bili-title.mjs'
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
const API = 'https://api.bilibili.com'

const DEFAULT_TIMEOUT = 15000

// ── 凭据、任务预算与风控 ──────────────────────────────────────────────────
//
// 限速策略照 dsh-bili-humanism 的做法（它的 docs/MEDIA_LIMITS.md）：
//   不是「两次请求间隔 N 秒」，而是**任务级预算**——一次任务总共多少请求、多少秒。
//   理由：间隔式限速挡不住长时间持续抓取；预算式在任务结束后彻底停，边界清楚。
//   它的数值：每次任务 12 次请求、90 秒总时长、单次媒体 32 MiB / JSON 4 MiB。
//   我们这里同样用 12 次 / 90 秒，单次视频下载上限 4 MiB（只为抽帧，不需要整段）。
//
// 另外三条也照它：
//   1) 请求前**重读**凭据——删掉文件即可立刻退回匿名，不用重启
//   2) 风控码（-352/-412/429）→ 进入持久暂停，**跨重启保持**，不自动解除
//   3) 不向 CDN 发送账号 Cookie（视频流只需要 range，不需要身份）
let credential = null

// 任务预算（每个 buildVideoContext 调用重置）
let taskRequests = 0
let taskStartedAt = 0
const TASK_MAX_REQUESTS = 12
const TASK_MAX_MS = 90000

// 风控暂停：持久化到 state/bili-cooldown.json，跨重启保持
let cooldownUntil = 0

// 凭据文件本身有问题时的诊断信息（不是风控，不触发暂停）
let lastCredentialError = ''

// 这几个码是 B 站的限流/风控信号：-352 风控校验、-412 请求被拦截、-101 未登录、429 太频繁
const RISK_CODES = new Set([-352, -412, -101, 429])

let cooldownPath = null

function loadCooldown(path) {
  cooldownPath = path
  try {
    if (!path || !fs.existsSync(path)) return
    const j = JSON.parse(fs.readFileSync(path, 'utf8'))
    const until = Number(j?.until)
    if (Number.isFinite(until) && until > cooldownUntil) cooldownUntil = until
  } catch { /* 坏文件按无暂停处理 */ }
}

/** 记录暂停并落盘，跨重启保持（照它「风控暂停跨重启保持，调度不会解除」）。 */
function tripCooldown(reason) {
  // 暂停 6 小时：它的文档只说"暂停"，没给时长；比 1 小时更保守，避免反复触发
  cooldownUntil = Date.now() + 6 * 60 * 60 * 1000
  try {
    if (cooldownPath) {
      fs.writeFileSync(cooldownPath, JSON.stringify({
        until: cooldownUntil,
        reason: String(reason ?? ''),
        at: new Date().toISOString(),
      }, null, 2), 'utf8')
    }
  } catch { /* 落盘失败仍保留内存态 */ }
}

/**
 * 从 state/bili-credential.json 读 sessdata。
 * 每次请求前都调用（不缓存），这样删文件 / 改文件立刻生效。
 */
/**
 * 从 state/bili-credential.json 读 sessdata。
 *
 * 校验照 dsh-bili-humanism 的 lib/network.mjs（credentialData）：
 * 它不只看长度，还要求不含 `\r` `\n` `;` —— 这是防 header 注入的关键：
 * 一个带换行的值能把 cookie 头劈开，塞进任意额外 header。
 * 另外它支持 disabled / read_valid 两个显式关闭位，我们也一并实现。
 */
function loadCredential(credentialPath) {
  try {
    if (!credentialPath || !fs.existsSync(credentialPath)) {
      credential = null
      return null
    }
    const j = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    // 显式关闭位：写 disabled:true 或 read_valid:false 就退回匿名
    if (j?.disabled === true || j?.read_valid === false) {
      credential = null
      return null
    }
    const s = String(j?.sessdata ?? '')
    const valid = s.length > 40 && s.length < 4096 && !/[\r\n;]/.test(s)
    if (!valid) {
      // 凭据非法 → 退回匿名，**但不进风控暂停**。
      // 它是我们自己文件写错，不是平台在限流；把它当成风控会让整条链路白停几小时。
      credential = null
      lastCredentialError = s.length > 0
        ? '凭据格式非法（太短/超长/含 CRLF 或分号），已退回匿名'
        : ''
      return null
    }
    lastCredentialError = ''
    credential = s
  } catch {
    credential = null
  }
  return credential
}

function resetTaskBudget() {
  taskRequests = 0
  taskStartedAt = Date.now()
}

/** 任务预算闸门：超过请求数或总时长就拒绝本次请求。 */
function gate() {
  if (Date.now() < cooldownUntil) return false
  if (!taskStartedAt) taskStartedAt = Date.now()
  if (taskRequests >= TASK_MAX_REQUESTS) return false
  if (Date.now() - taskStartedAt > TASK_MAX_MS) return false
  taskRequests += 1
  return true
}

/** 遇到风控码就进入持久暂停，避免越撞越死。 */
function onRiskCode(code, message) {
  tripCooldown(`${code} ${message ?? ''}`.trim())
}

// ── URL 白名单（照 lib/network.mjs 的 permitted()） ─────────────────────────
// 它把「能访问哪些 URL」写成四层校验：协议、无凭据、主机、路径。
// 我们这里只访问 api.bilibili.com 的固定几个路径，所以照抄这层最划算：
// 拼 URL 的地方全是本文件自己写的，但一个拼错就会把请求发到别处，白名单挡住它。
const ALLOWED_API_PATHS = new Set([
  '/x/web-interface/view',
  '/x/player/playurl',
  '/x/player/videoshot',   // 故事板：只给拼图地址与时间索引，不下载视频
  '/x/web-interface/search/type',  // 按标题兜底搜视频（卡片没带链接时）
  '/x/v2/reply',
  '/x/v1/dm/list.so',
])

/** 校验 API URL：https + 无用户名密码 + api.bilibili.com + 路径在白名单内。 */
function assertAllowedApi(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('URL 非法')
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('URL 被拒绝')
  if (u.hostname !== 'api.bilibili.com') throw new Error(`主机不在白名单：${u.hostname}`)
  if (!ALLOWED_API_PATHS.has(u.pathname)) throw new Error(`路径不在白名单：${u.pathname}`)
  return u
}

/**
 * 校验媒体（视频流）URL。照它 permitted() 的媒体分支：
 *   · 标准端口 + `*.bilivideo.com`
 *   · 或 `*.mcdn.bilivideo.cn` 且标准端口或 8082
 * 端口这层它有讲究：B 站的 mcdn 节点会走 8082，其他端口一律拒绝。
 */
/**
 * 判断一个媒体 URL 是否可信（返回 true/false，不抛错），用于**从多条轨里挑**。
 *
 * ⚠️ 这里和 dsh-bili-humanism 不同，而且必须不同：
 * 它的白名单只允许 `*.bilivideo.com` 与 `*.mcdn.bilivideo.cn`（端口 443/8082）。
 * 但实测（2026-10-27）B 站现在大量走 `*.edge.mountaintoys.cn`——
 * 那是它的 P2P/边缘节点，同一个视频的 480p 主地址就在这个域上。
 * 照抄它的白名单会直接拦掉一半播放地址（抽帧全废）。
 *
 * 所以策略是「优先挑清单内的，实在没有才放宽」：
 *   1) 严格清单（它那份）→ 最佳
 *   2) 补充清单：B 站自己的其它 CDN 域名（mountaintoys 等）→ 次选
 *   3) 其他 https 公网地址 → 拒绝
 */
const STRICT_MEDIA_HOSTS = [
  /(^|\.)bilivideo\.com$/,
  /(^|\.)bilivideo\.cn$/,
]
const EXTRA_MEDIA_HOSTS = [
  /\.edge\.mountaintoys\.cn$/,
  /(^|\.)hdslb\.com$/,
  /(^|\.)bilibili\.com$/,
]

function mediaTier(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return 0
  }
  if (u.protocol !== 'https:' || u.username || u.password) return 0
  const standardPort = !u.port || u.port === '443'
  if (STRICT_MEDIA_HOSTS.some((re) => re.test(u.hostname)) && (standardPort || u.port === '8082')) return 2
  if (EXTRA_MEDIA_HOSTS.some((re) => re.test(u.hostname)) && standardPort) return 1
  return 0
}

/** 最终采用前的硬校验：只接受上面两档。 */
function assertAllowedMedia(raw) {
  const tier = mediaTier(raw)
  if (tier === 0) {
    let host = '?'
    try { host = new URL(raw).hostname } catch {}
    throw new Error(`播放地址不在允许的 CDN 清单内：${host}`)
  }
  return new URL(raw)
}

/**
 * 发一次 GET。照它的做法：
 *   · 传输异常最多重试 3 次（只重试传输异常，不重试 HTTP/风控响应）
 *   · 每次重试都计入 requests 预算
 *   · Cookie 只发给 api.bilibili.com（媒体/字幕域名不带）
 */
async function getJson(url, timeout = DEFAULT_TIMEOUT, { auth = false } = {}) {
  assertAllowedApi(url)
  if (!gate()) throw new Error('请求预算用尽或处于风控暂停')
  const headers = auth && credential
    ? { ...BASE_HEADERS, cookie: `SESSDATA=${credential}` }
    : BASE_HEADERS
  const attempts = 3
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
      // 风控/限流响应直接暂停，不重试（它：401/403/412/429 → store.pause）
      if ([401, 403, 412, 429].includes(res.status)) {
        tripCooldown(`HTTP_${res.status}`)
        throw new Error(`平台拒绝 HTTP ${res.status}，已暂停`)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      const j = await res.json()
      if (RISK_CODES.has(j.code)) {
        onRiskCode(j.code, j.message)
        throw new Error(`平台风控 code=${j.code}，已暂停`)
      }
      return j
    } catch (error) {
      lastError = error
      // 风控/暂停类错误不重试
      if (/已暂停/.test(error.message)) throw error
      const isLast = attempt + 1 === attempts
      if (isLast) throw error
      // 重试也要占预算（它每次 attempt 都 spend("requests")）
      if (!gate()) throw new Error('重试时预算用尽')
      await new Promise((r) => setTimeout(r, Math.min(150 * (attempt + 1), 2000)))
    }
  }
  throw lastError ?? new Error('请求失败')
}

/** 从任意文本里抽 bvid / av 号 / b23.tv 短链。返回 { bvid } 或 { shortUrl }。 */
export function extractBiliTarget(text) {
  const src = String(text ?? '')
  const bv = /\b(BV[0-9A-Za-z]{10})\b/.exec(src)
  if (bv) return { bvid: bv[1] }
  const av = /\bav(\d{4,})\b/i.exec(src)
  if (av) return { avid: av[1] }
  // b23.tv 短链或普通视频链接
  const short = /\bhttps?:\/\/b23\.tv\/[A-Za-z0-9]+/i.exec(src)
  if (short) return { shortUrl: short[0] }
  const any = /\bhttps?:\/\/[^\s"'）)]+bilibili\.com\/video\/[^\s"'）)]+/i.exec(src)
  if (any) return { url: any[0] }
  return null
}

/** 展开 b23.tv 短链，拿到最终 URL。
 *
 * 照 dsh-bili-humanism 的边界（docs/SECURITY.md）：「拒绝用户信息 URL、其他目标与重定向」。
 * 所以这里手动跟重定向，每一跳都校验域名，只允许 b23.tv / bilibili.com；
 * 一旦跳到别的域就停下（不继续跟），避免短链把请求引到任意地址。
 */
const ALLOWED_REDIRECT_HOSTS = new Set(['b23.tv', 'www.bilibili.com', 'bilibili.com', 'm.bilibili.com'])

async function expandShortUrl(shortUrl) {
  try {
    if (!gate()) return null
    let url = shortUrl
    for (let hop = 0; hop < 4; hop += 1) {
      const res = await fetch(url, {
        headers: BASE_HEADERS,
        redirect: 'manual',
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
      })
      res.body?.cancel?.()
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return null
        const next = new URL(loc, url)
        if (!ALLOWED_REDIRECT_HOSTS.has(next.hostname)) return null  // 跳去别处就不跟
        url = next.toString()
        continue
      }
      const hit = extractBiliTarget(url)
      return hit ?? { url }
    }
    return null
  } catch {
    return null
  }
}

/** 把 extractBiliTarget 的结果解析成 { bvid, cid, title, ... } 元信息。 */
export async function resolveVideo(target) {
  let t = target
  if (t.shortUrl) t = (await expandShortUrl(t.shortUrl)) ?? t

  if (t.bvid) {
    const j = await getJson(`${API}/x/web-interface/view?bvid=${t.bvid}`)
    if (j.code !== 0) throw new Error(`view 接口 code=${j.code} ${j.message}`)
    return normalizeMeta(j.data)
  }
  if (t.avid) {
    const j = await getJson(`${API}/x/web-interface/view?aid=${t.avid}`)
    if (j.code !== 0) throw new Error(`view 接口 code=${j.code} ${j.message}`)
    return normalizeMeta(j.data)
  }
  if (t.url) {
    const m = /\b(BV[0-9A-Za-z]{10})\b/.exec(t.url)
    if (m) return resolveVideo({ bvid: m[1] })
  }
  throw new Error('无法从这段文本里认出 B 站视频编号')
}

function normalizeMeta(d) {
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.pages?.[0]?.cid ?? d.cid,
    title: d.title,
    owner: d.owner?.name ?? '',
    durationSec: d.duration ?? 0,
    views: d.stat?.view ?? 0,
    danmakuCount: d.stat?.danmaku ?? 0,
    desc: String(d.desc ?? '').trim(),
    cover: d.pic ?? '',
    pages: d.pages?.length ?? 1,
  }
}

/** 拿弹幕（XML 老接口，匿名可用；实测 641 条）。 */
export async function fetchDanmaku(meta, limit = 40) {
  if (!meta?.cid) return []
  if (!gate()) return []   // 预算/暂停期间直接跳过弹幕
  try {
    const res = await fetch(`${API}/x/v1/dm/list.so?oid=${meta.cid}`, {
      headers: BASE_HEADERS,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })
    const buf = Buffer.from(await res.arrayBuffer())
    let text
    try { text = new TextDecoder('utf-8').decode(buf) } catch { text = new TextDecoder('gbk').decode(buf) }
    const all = []
    for (const m of text.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
      const t = parseFloat((m[1].split(',')[0] || '0'))
      const msg = m[2].trim()
      if (!msg) continue
      all.push({ t: Number.isFinite(t) ? t : 0, text: msg })
    }
    if (!all.length) return []
    // 弹幕的问题不是多，是**重复**：「哦鲸鲸」在一支视频里可能刷 20 遍。
    // 所以先按正文去重（同一句只留最早的一条），再去掉纯符号/纯空白，
    // 最后按时间均匀抽样——保留时间点，因为"观众在哪一秒有反应"比原文更有信息。
    const seen = new Map()
    for (const d of all) {
      const clean = d.text.replace(/\s+/g, ' ').trim()
      // 过滤：少于 2 个字符、或全是符号/装饰字符的弹幕没有信息量
      if (clean.replace(/[\p{P}\p{S}\s]/gu, '').length < 2) continue
      if (!seen.has(clean)) seen.set(clean, { t: d.t, text: clean })
    }
    const uniq = [...seen.values()].sort((a, b) => a.t - b.t)
    if (!uniq.length) return []
    const step = Math.max(1, Math.floor(uniq.length / limit))
    const picked = []
    for (let i = 0; i < uniq.length && picked.length < limit; i += step) picked.push(uniq[i])
    return picked
  } catch {
    return []
  }
}

/**
 * 拿高赞评论。
 *
 * 实测差异很大：匿名时第 1 页只有 3 条、第 2 页起全空（B 站匿名只给最热几条）；
 * 带上小号 SESSDATA 后每页 20 条、可继续翻。所以：
 *   · 有凭据 → 按 sort=1（按点赞）翻 1~2 页，凑够 limit
 *   · 无凭据 → 只请求第 1 页，如实拿到几条是几条
 * 返回 { comments, loggedIn }，让上层能在提示词里说清"看到的是全部热门还是仅几条"。
 */
export async function fetchTopComments(meta, limit = 10) {
  if (!meta?.aid) return { comments: [], loggedIn: false }
  const ok = await gate()
  if (!ok) return { comments: [], loggedIn: false }

  const loggedIn = Boolean(credential)
  const out = []
  const maxPages = loggedIn ? 2 : 1
  try {
    for (let pn = 1; pn <= maxPages && out.length < limit; pn += 1) {
      if (pn > 1) {
        const okNext = await gate()
        if (!okNext) break
      }
      const j = await getJson(
        `${API}/x/v2/reply?type=1&oid=${meta.aid}&sort=1&ps=20&pn=${pn}`,
        DEFAULT_TIMEOUT,
        { auth: loggedIn },
      )
      if (j.code !== 0) break
      const page = j.data?.replies ?? []
      if (!page.length) break
      for (const r of page) {
        out.push({
          user: r.member?.uname ?? '',
          like: r.like ?? 0,
          text: String(r.content?.message ?? '').replace(/\s+/g, ' ').slice(0, 140),
        })
        if (out.length >= limit) break
      }
    }
    // 高赞优先（sort=1 已按赞排，这里再稳定排一次，避免翻页边界处顺序抖动）
    out.sort((a, b) => b.like - a.like)
    return { comments: out.slice(0, limit), loggedIn }
  } catch {
    return { comments: out.slice(0, limit), loggedIn }
  }
}

/**
 * 下载视频头部若干 MB（Range），够抽帧就行，不取完整片段。
 *
 * 两条照 dsh-bili-humanism 的边界：
 *   · **不向 CDN 发送账号 Cookie**（它 docs/SECURITY.md 明写）——视频流只要 range，不需要身份
 *   · 单次媒体响应上限（它 32 MiB，我们只取抽帧够用的 4 MiB，更保守）
 */
async function fetchVideoHead(meta, maxBytes, tmpDir) {
  const j = await getJson(
    `${API}/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&qn=16&fnval=16&fourk=0`,
    20000,
    { auth: true },   // 取地址可以带身份（能拿到更高清晰度），下载不带
  )
  if (j.code !== 0) throw new Error(`playurl code=${j.code} ${j.message}`)
  const videos = j.data?.dash?.video ?? []
  if (!videos.length) throw new Error('没有可用的视频轨')

  // 挑最接近 480p 的一轨（id=32），拿不到就取第一条
  const pick = videos.find((v) => v.id === 32) ?? videos[0]
  // 一条轨常常有 2~3 个地址（baseUrl + backupUrl），且不同轨可能落在不同 CDN。
  // 照它「抽帧可沿同清晰度、同尺寸备选 CDN 回退」的做法，先按可信度（tier）挑，再逐个尝试。
  const candidates = []
  const pushUrl = (u) => {
    if (!u) return
    const tier = mediaTier(u)
    if (tier > 0 && !candidates.some((c) => c.url === u)) candidates.push({ url: u, tier })
  }
  pushUrl(pick.baseUrl || pick.base_url)
  for (const u of pick.backupUrl || pick.backup_url || []) pushUrl(u)
  // 同清晰度的其它轨也当前备选（B 站常给同 id 多份）
  for (const v of videos) {
    if (v === pick || v.id !== pick.id) continue
    pushUrl(v.baseUrl || v.base_url)
    for (const u of v.backupUrl || v.backup_url || []) pushUrl(u)
  }
  if (!candidates.length) throw new Error('这条视频没有可信的播放地址')
  candidates.sort((a, b) => b.tier - a.tier)   // 严格清单优先

  let lastError = null
  for (const cand of candidates) {
    assertAllowedMedia(cand.url)
    if (!gate()) throw new Error('请求预算用尽或处于风控暂停')
    try {
      const res = await fetch(cand.url, {
        // 媒体 CDN 会校验 Referer/UA（实测：只给 UA 和 Range 时部分节点回 403）。
        // 这里补齐 Referer，但**仍然不带 cookie**（照它：Cookie 只发给 api.bilibili.com）。
        headers: {
          'user-agent': UA,
          referer: `https://www.bilibili.com/video/${meta.bvid}/`,
          origin: 'https://www.bilibili.com',
          range: `bytes=0-${maxBytes - 1}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok && res.status !== 206) {
        // 403/404 属于「这个节点不行」，换下一个源再试（catch 里会继续循环）
        throw new Error(`HTTP ${res.status}`)
      }
      // 大小校验：先看声明的 Content-Length，再按实际读取累计（照它 declared + streamed 双重）
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) throw new Error(`视频响应过大（声明 ${declared} 字节）`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`视频响应过大（实际 ${buf.length} 字节）`)
      fs.mkdirSync(tmpDir, { recursive: true })
      const file = path.join(tmpDir, `${meta.bvid}.m4s`)
      fs.writeFileSync(file, buf)
      return { file, quality: pick.id, width: pick.width, height: pick.height, bytes: buf.length, tier: cand.tier }
    } catch (error) {
      lastError = error
      if (/预算|暂停/.test(error.message)) throw error   // 预算/暂停不换源重试
    }
  }
  throw lastError ?? new Error('所有播放地址都不可用')
}

/**
 * 按视频时长决定抽几帧、分几页。
 * 依据：dsh-bili-humanism 的经验（长视频抽 6 帧必然漏内容，要分页），
 * 但这里更保守——一次只给 1~2 张图，避免把上下文撑爆。
 */
function planFrames(durationSec) {
  const min = durationSec / 60
  if (min <= 3) return { count: 6, cols: 3, rows: 2, pages: 1 }
  if (min <= 10) return { count: 9, cols: 3, rows: 3, pages: 1 }
  if (min <= 30) return { count: 12, cols: 4, rows: 3, pages: 2 }
  return { count: 15, cols: 5, rows: 3, pages: 2 }
}

/** 抽帧并拼成网格图。返回 [{ file, cols, rows }]。 */
export function extractFrames(videoFile, plan, tmpDir, ffmpegPath) {
  const interval = 4 // 每 4 秒取 1 帧
  const stripPattern = path.join(tmpDir, 'f_%03d.jpg')
  for (const f of fs.readdirSync(tmpDir)) {
    if (f.startsWith('f_')) fs.rmSync(path.join(tmpDir, f), { force: true })
  }
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoFile,
    '-vf', `fps=1/${interval},scale=320:-1`,
    '-frames:v', String(plan.count),
    '-q:v', '5',
    stripPattern,
  ], { timeout: 90000, stdio: 'ignore' })

  const frames = fs.readdirSync(tmpDir).filter((n) => /^f_\d+\.jpg$/.test(n)).sort()
  if (!frames.length) return []

  const perPage = plan.pages > 1 ? Math.ceil(frames.length / plan.pages) : frames.length
  const outputs = []
  for (let p = 0; p < plan.pages; p += 1) {
    const chunk = frames.slice(p * perPage, (p + 1) * perPage)
    if (!chunk.length) continue
    const rows = Math.ceil(chunk.length / plan.cols)
    const list = path.join(tmpDir, `list_${p}.txt`)
    fs.writeFileSync(list, chunk.map((n) => `file '${path.join(tmpDir, n)}'`).join('\n'))
    const out = path.join(tmpDir, `tile_${p}.jpg`)
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `tile=${plan.cols}x${rows}:padding=3:margin=3:color=white`,
      '-frames:v', '1', '-q:v', '4', out,
    ], { timeout: 90000, stdio: 'ignore' })
    if (fs.existsSync(out)) outputs.push({ file: out, cols: plan.cols, rows })
  }
  return outputs
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 主入口：给一段文本（可能是卡片标题或链接），产出注入用的上下文块。
 * @returns {Promise<{ok:boolean, block?:string, images?:string[], error?:string}>}
 */
export async function buildVideoContext(text, {
  ffmpegPath,
  tmpDir,
  credentialPath = null,
  cooldownPath = null,
  offSwitchPath = null,
  danmakuLimit = 40,
  commentLimit = 10,
  maxVideoBytes = 4 * 1024 * 1024,
  withFrames = true,
  framesMode = 'auto',   // auto=短视频走故事板/长视频走下载；storyboard；download
  titleCachePath = null,  // 按标题搜视频的结果缓存（卡片里没有链接时的兜底）
} = {}) {
  // 总开关：存在这个文件就完全停用，不用改配置、不用重启
  if (offSwitchPath && fs.existsSync(offSwitchPath)) {
    return { ok: false, error: '已被 state/bili-off 停用' }
  }

  const target = extractBiliTarget(text)

  // 每次任务开始都重读凭据与暂停状态：删文件 / 改文件立刻生效（照它的做法）
  loadCredential(credentialPath)
  loadCooldown(cooldownPath)
  resetTaskBudget()
  if (Date.now() < cooldownUntil) {
    const mins = Math.ceil((cooldownUntil - Date.now()) / 60000)
    return { ok: false, error: `处于风控暂停，还需 ${mins} 分钟` }
  }

  let meta
  if (!target) {
    // 没有链接时的兜底：按标题搜一次（借鉴 bili-scroll `uid.mjs` 用昵称反查 UID 的思路）
    // 触发条件：文本里没有 BV/av/短链，但看起来像一条视频分享（有「哔哩哔哩」或「【…】」）
    const looksLikeShare = /哔哩哔哩|bilibili|【[^】]{4,}】/i.test(text)
    if (!looksLikeShare) return { ok: false, error: '这条消息里没认出 B 站视频' }
    const byTitle = await resolveVideoByTitle({
      title: text.replace(/https?:\/\/\S+/g, '').trim(),
      apiFetch: (url, timeout, opts) => getJson(url, timeout, opts),
      cachePath: titleCachePath,
    })
    if (!byTitle?.bvid) return { ok: false, error: '这条消息里没认出 B 站视频（按标题也没搜到）' }
    try {
      meta = await resolveVideo({ bvid: byTitle.bvid })
    } catch (error) {
      return { ok: false, error: `取视频信息失败：${error.message}` }
    }
  } else {
    try {
      meta = await resolveVideo(target)
    } catch (error) {
      return { ok: false, error: `取视频信息失败：${error.message}` }
    }
  }

  const [danmaku, commentResult] = await Promise.all([
    fetchDanmaku(meta, danmakuLimit),
    fetchTopComments(meta, commentLimit),
  ])
  const comments = commentResult.comments

  const lines = []
  lines.push(`【他刚分享了一个视频】`)
  lines.push(`标题：${meta.title}`)
  if (meta.owner) lines.push(`UP主：${meta.owner}`)
  lines.push(`时长：${fmtTime(meta.durationSec)}｜播放：${meta.views}`)
  if (meta.desc) lines.push(`简介：${meta.desc.slice(0, 200).replace(/\n/g, ' ')}`)

  let images = []
  let frameNote = ''

  if (withFrames && ffmpegPath && meta.durationSec > 0) {
    const plan = planFrames(meta.durationSec)
    // 两条抽帧路线，按时长切换（实测数据见下）：
    //   · 故事板：B 站自带缩略图拼图，480×270/帧、35 帧覆盖全片、92KB、0.7 秒
    //             —— 快 10 倍但画质是缩略图
    //   · 下载抽帧：Range 取视频头部 + ffmpeg，854×478、清晰，但要 2~4MB
    // 短视频（≤3 分钟）画质要求低、故事板够用；长视频故事板会更糊，走下载。
    // framesMode 可以覆盖：'storyboard' 强制走故事板，'download' 强制走下载。
    const preferStoryboard = framesMode === 'storyboard'
      || (framesMode !== 'download' && meta.durationSec <= 180)

    if (preferStoryboard) {
      try {
        const sb = await framesFromStoryboard({
          meta,
          want: plan.count,
          cols: plan.cols,
          tmpDir,
          ffmpegPath,
          apiFetch: (url, timeout, opts) => getJson(url, timeout, opts),
        })
        if (sb?.files?.length) {
          images = sb.files
          frameNote = sb.note
          lines.push(frameNote)
        }
      } catch { /* 静默回退到下载抽帧 */ }
    }

    if (!images.length) {
      try {
        const head = await fetchVideoHead(meta, maxVideoBytes, tmpDir)
        const tiles = extractFrames(head.file, plan, tmpDir, ffmpegPath)
        fs.rmSync(head.file, { force: true })
        if (tiles.length) {
          images = tiles.map((t) => t.file)
          frameNote = `画面：按时间均匀抽了 ${plan.count} 个瞬间，拼成 ${tiles.length} 张图（${plan.cols}列）`
          lines.push(frameNote)
        } else {
          frameNote = '画面：没能抽到（已跳过）'
          lines.push(frameNote)
        }
      } catch (error) {
        lines.push(`画面：没取到（${error.message.slice(0, 60)}）`)
      }
    }
  } else if (!withFrames) {
    lines.push('画面：这次没有提供')
  }

  if (danmaku.length) {
    lines.push('')
    lines.push(`弹幕里大家在说（共 ${meta.danmakuCount} 条，抽样 ${danmaku.length} 条）：`)
    for (const d of danmaku) lines.push(`  ${fmtTime(d.t)}  ${d.text.slice(0, 50)}`)
  }

  if (comments.length) {
    lines.push('')
    // 有凭据时是高赞完整版；没凭据时 B 站只给最热几条（实测 3 条），必须说清，
    // 否则她会把"只有三条"当成"大家都这么说"。
    lines.push(commentResult.loggedIn
      ? `高赞评论（按赞数，共取 ${comments.length} 条）：`
      : `高赞评论（未登录，B 站只公开最热 ${comments.length} 条）：`)
    for (const c of comments) lines.push(`  ${c.text.slice(0, 110)}（${c.like}赞）`)
  }

  lines.push('')
  lines.push(
    images.length
      ? '（你看到的是这几个瞬间的截图，不是整段视频；不要在没看到的地方编造细节。）'
      : '（你只知道标题和大家的反应，没看到画面；别装作看过。）',
  )

  return { ok: true, block: lines.join('\n'), images, meta, loggedIn: commentResult.loggedIn }
}

/** 清理一次任务产生的临时文件。 */
export function cleanupVideoTmp(tmpDir) {
  try {
    if (!fs.existsSync(tmpDir)) return
    for (const n of fs.readdirSync(tmpDir)) {
      // 注意 sb_* / sheet_* 是故事板路径留下的；sb-tile.jpg 是**要留着的成品**，不能删。
      if (/^(f_\d+\.jpg|tile_\d+\.jpg|list_\d+\.txt|sb_\d+\.jpg|sheet_\d+\.jpg|sb-list\.txt|BV[0-9A-Za-z]+\.m4s)$/.test(n)) {
        fs.rmSync(path.join(tmpDir, n), { force: true })
      }
    }
  } catch { /* 清理失败不影响主流程 */ }
}
