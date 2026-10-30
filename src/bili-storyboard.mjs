// 用 B 站自带的故事板（x/player/videoshot）拿画面：不下载视频、不跑 ffmpeg。
//
// 为什么换掉原来「下载视频头部 → ffmpeg 抽帧」那条路：
//   · 故事板是一张 10×10 的拼图，**92 KB 就覆盖整支 168 秒视频的 35 个关键帧**
//   · 原方案要 Range 下载 2~4 MB 视频、调用 ffmpeg、写临时文件、再清理
//   · 故事板由 B 站 CDN 直接给图，失败退回原方案也很快
//
// 做法参考 c1overzz/dsh-bili-scroll 的 vendor/bilibili-mcp（MIT）里的 videoshot 实现，
// 但它用 Pillow 裁切；我们只裁网格，ffmpeg 的 crop/tile 足够，省一个 Python 依赖。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SHEET_HOSTS = [/^bimp\.hdslb\.com$/, /^boss\.hdslb\.com$/, /(^|\.)hdslb\.com$/, /(^|\.)bilibili\.com$/]

/**
 * 把 videoshot 的 index 归一成 [{sec, tile}]。
 *
 * 时间单位实测两种都出现过（秒 / 毫秒）。**不能**用「大于某个数就当毫秒」这种判据——
 * 6 小时视频的秒数（22163）会被误判，三帧全塌到同一块。
 * 只能靠和视频总时长比较：超过 1.5 倍才当毫秒。
 */
function normalizeIndex(rawIndex, durationSec) {
  const raws = []
  for (let i = 0; i < (rawIndex?.length ?? 0); i += 1) {
    const v = Number(rawIndex[i])
    if (Number.isFinite(v)) raws.push({ v, tile: i })
  }
  if (!raws.length) return []
  const biggest = Math.max(...raws.map((r) => r.v))
  const looksMs = durationSec > 0 && biggest > durationSec * 1.5
  const scale = looksMs ? 1000 : 1
  return raws.map((r) => ({ sec: r.v / scale, tile: r.tile }))
}

async function fetchSheet(url, timeoutMs = 30000) {
  const withProto = url.startsWith('//') ? `https:${url}` : url
  // 只从 B 站自己的图床取，且不带 cookie（图床不需要身份）
  let u
  try {
    u = new URL(withProto)
  } catch {
    throw new Error('故事板地址非法')
  }
  if (u.protocol !== 'https:' || !SHEET_HOSTS.some((re) => re.test(u.hostname))) {
    throw new Error(`故事板域名不在清单内：${u.hostname}`)
  }
  const res = await fetch(u, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`故事板下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 8 * 1024 * 1024) throw new Error('故事板过大')
  return buf
}

/**
 * 用故事板拿到 N 张画面，拼成一张网格图。
 * @returns {Promise<{files:string[], note:string}|null>} null 表示这条路不可用（调用方回退）
 */
export async function framesFromStoryboard({
  meta,
  want = 6,
  cols = 3,
  tmpDir,
  ffmpegPath,
  apiFetch,          // 由调用方注入，复用它的预算/白名单/凭据
  timeoutMs = 20000,
} = {}) {
  if (!meta?.bvid || !meta?.cid || !ffmpegPath) return null
  if (!apiFetch) return null

  const j = await apiFetch(
    `https://api.bilibili.com/x/player/videoshot?bvid=${meta.bvid}&cid=${meta.cid}&index=1`,
    timeoutMs,
    { auth: true },
  )
  if (j?.code !== 0 || !j?.data) return null

  const d = j.data
  const entries = normalizeIndex(d.index, Number(meta.durationSec) || 0)
  if (!entries.length) return null

  const tw = Number(d.img_x_size) || 480
  const th = Number(d.img_y_size) || 270
  const perSheet = (Number(d.img_x_len) || 10) * (Number(d.img_y_len) || 10)
  const sheets = d.image ?? []
  if (!sheets.length) return null

  // 按时长均匀取 want 个时间点，每个匹配最近的 index 块
  const dur = Number(meta.durationSec) > 0
    ? Number(meta.durationSec)
    : (entries[entries.length - 1]?.sec ?? 0)
  const picks = []
  for (let i = 0; i < want; i += 1) {
    const t = dur > 0 ? (dur * (i + 0.5)) / want : entries[Math.floor((entries.length * i) / want)].sec
    let best = entries[0]
    for (const e of entries) if (Math.abs(e.sec - t) < Math.abs(best.sec - t)) best = e
    if (picks.some((p) => p.tile === best.tile)) continue
    picks.push(best)
  }
  if (!picks.length) return null

  fs.mkdirSync(tmpDir, { recursive: true })
  const decoded = []
  const sheetCache = new Map()
  try {
    for (const p of picks) {
      const sheetNo = Math.floor(p.tile / perSheet)
      const pos = p.tile % perSheet
      const sheetUrl = sheets[sheetNo]
      if (!sheetUrl) continue
      let sheetFile = sheetCache.get(sheetNo)
      if (!sheetFile) {
        const buf = await fetchSheet(sheetUrl)
        sheetFile = path.join(tmpDir, `sheet_${sheetNo}.jpg`)
        fs.writeFileSync(sheetFile, buf)
        sheetCache.set(sheetNo, sheetFile)
      }
      // 拼图是 10×10 + 无间隙网格，用 crop 精确切出第 pos 块
      const cx = (pos % (Number(d.img_x_len) || 10)) * tw
      const cy = Math.floor(pos / (Number(d.img_x_len) || 10)) * th
      const out = path.join(tmpDir, `sb_${p.tile}.jpg`)
      execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sheetFile,
        '-vf', `crop=${tw}:${th}:${cx}:${cy},scale=320:-1`,
        '-frames:v', '1', '-q:v', '5', out,
      ], { timeout: 30000, stdio: 'ignore' })
      if (fs.existsSync(out)) decoded.push(out)
    }
  } catch {
    // 任何一步失败都交给调用方回退到「下载视频抽帧」
    return null
  } finally {
    for (const f of sheetCache.values()) { try { fs.rmSync(f, { force: true }) } catch {} }
  }

  if (!decoded.length) return null

  // 拼成一张网格
  const rows = Math.ceil(decoded.length / cols)
  const list = path.join(tmpDir, 'sb-list.txt')
  fs.writeFileSync(list, decoded.map((f) => `file '${f}'`).join('\n'))
  const tileOut = path.join(tmpDir, 'sb-tile.jpg')
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `tile=${cols}x${rows}:padding=3:margin=3:color=white`,
      '-frames:v', '1', '-q:v', '4', tileOut,
    ], { timeout: 30000, stdio: 'ignore' })
  } catch {
    return null
  }
  if (!fs.existsSync(tileOut)) return null

  // 清理单帧，只留拼好的那张
  for (const f of decoded) { try { fs.rmSync(f, { force: true }) } catch {} }
  try { fs.rmSync(list, { force: true }) } catch {}

  return {
    files: [tileOut],
    note: `画面：故事板 ${decoded.length} 个关键帧（共 ${entries.length} 个可抽），拼成 1 张（${cols}列）`,
  }
}
