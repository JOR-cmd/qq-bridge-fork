// 标题 → 视频：卡片里没有链接时的兜底（借鉴 bili-scroll 的 lib/uid.mjs 用昵称反查 UID 的思路）
//
// 场景：QQ 分享卡片有时只带标题、带不出跳转链接（或解析失败），
// 这时按标题去 B 站搜一次，取最匹配的那条，再走正常的取视频流程。
//
// 匹配规则（照 uid.mjs「先精确匹配，再退到第一个结果」）：
//   1) 标题完全一致（去空格/大小写）→ 直接采用
//   2) 否则要求相似度足够高（至少 2 个连续的 4 字片段命中），避免搜出无关视频
//   3) 命中结果缓存到 state/bili-title-cache.json，避免同一标题反复搜索
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 去掉标题里的装饰：【】、emoji、空格、大小写，只留下用于比对的正文 */
function normalizeTitle(s) {
  let t = String(s ?? '')
  // ① 先剥括号（它们在末尾来源标记的外面）
  t = t.replace(/[【】\[\]「」『』《》()（）]/g, '')
  // ② 再剥末尾的来源标记「-哔哩哔哩」/「-bilibili」
  t = t.replace(/[-–—\s]*(哔哩哔哩|bilibili)\s*$/i, '')
  // ③ emoji / 分隔符 / 空白 / 大小写
  return t
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[-_—–|·・\s]+/g, '')
    .toLowerCase()
}

/** 取 4 字片段做重合度（中文没有分词，4 字足够区分） */
function ngrams4(s) {
  const out = new Set()
  for (let i = 0; i + 4 <= s.length; i += 1) out.add(s.slice(i, i + 4))
  return out
}

function similarity(a, b) {
  const A = ngrams4(normalizeTitle(a))
  const B = ngrams4(normalizeTitle(b))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.min(A.size, B.size)
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { return {} }
}
function writeCache(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  } catch { /* 写不了就算了 */ }
}

/**
 * 按标题搜一个视频。
 * @param {object} opts
 * @param {string} opts.title
 * @param {(url:string,timeout?:number,opts?:object)=>Promise<any>} opts.apiFetch  复用调用方的预算/白名单/凭据
 * @param {string} [opts.cachePath]
 * @returns {Promise<{bvid:string,title:string,score:number}|null>}
 */
export async function resolveVideoByTitle({ title, apiFetch, cachePath = null } = {}) {
  const key = normalizeTitle(title)
  if (key.length < 3 || !apiFetch) return null

  // 缓存：同一标题 7 天内不重复搜
  const cache = cachePath ? readCache(cachePath) : {}
  const cached = cache[key]
  if (cached && cached.bvid && Date.now() - Number(cached.at || 0) < 7 * 24 * 60 * 60 * 1000) {
    return { bvid: cached.bvid, title: cached.title ?? '', score: cached.score ?? 1, cached: true }
  }

  let j
  try {
    // 只搜视频；标题里可能带空格，交给 URLSearchParams 编码
    const q = new URLSearchParams({ search_type: 'video', keyword: title.replace(/[【】]/g, ' ').trim() })
    j = await apiFetch(`https://api.bilibili.com/x/web-interface/search/type?${q}`, 20000, { auth: true })
  } catch {
    return null
  }
  if (j?.code !== 0) return null

  const list = j.data?.result ?? []
  if (!list.length) return null

  // 先精确匹配
  let best = null
  for (const item of list) {
    const rawTitle = String(item.title ?? '').replace(/<[^>]+>/g, '')   // 搜索结果标题带 <em> 高亮
    const exact = normalizeTitle(rawTitle) === key
    const score = exact ? 1 : similarity(rawTitle, title)
    if (!best || score > best.score) best = { bvid: item.bvid, title: rawTitle, score }
  }
  // 门槛：精确匹配直接过；否则要求相似度 ≥ 0.6（4 字片段重合 60% 以上）
  if (!best || best.score < 0.6) return null

  if (cachePath) {
    cache[key] = { bvid: best.bvid, title: best.title, score: best.score, at: Date.now() }
    writeCache(cachePath, cache)
  }
  return best
}
