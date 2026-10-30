// B 站功能回归：链接识别 / 故事板 / 下载抽帧 / 标题兜底 / 不该触发 / 总开关
// 用法：node test-all-bili.mjs
import fs from 'node:fs'
import { buildVideoContext, extractBiliTarget } from './src/bili-video.mjs'

const TMP = '<REPO_ROOT>/state/media-tmp/bili'
const base = {
  ffmpegPath: '<WORK_ROOT>/ffmpeg/bin/ffmpeg.exe',
  tmpDir: TMP,
  credentialPath: '<REPO_ROOT>/state/bili-credential.json',
  cooldownPath: './state/bili-cooldown.json',
  offSwitchPath: './state/bili-off',
  titleCachePath: './state/bili-title-cache.json',
  danmakuLimit: 20,
  commentLimit: 8,
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

console.log('\n[1] 链接识别')
for (const [t, want] of [
  ['https://www.bilibili.com/video/BV1eGaz6JEJa/', 'bvid'],
  ['BV1eGaz6JEJa', 'bvid'],
  ['av123456', 'avid'],
  ['https://b23.tv/foABsQr', 'shortUrl'],
  ['随便说句话', null],
]) {
  const r = extractBiliTarget(t)
  const got = r ? Object.keys(r)[0] : null
  check(`${t.slice(0, 44).padEnd(46)} → ${got}`, got === want)
}

console.log('\n[2] 短视频（≤3 分钟）走故事板')
const short = await buildVideoContext('https://www.bilibili.com/video/BV1eGaz6JEJa/', base)
check('取到', short.ok, short.error || '')
check('画面行写的是故事板', /画面：故事板/.test(short.block || ''), (short.block || '').match(/画面：.*/)?.[0] ?? '')
check('有图', (short.images?.length ?? 0) > 0)
check('登录生效（评论 >3 条）', (short.block || '').split('\n').filter((l) => /赞）$/.test(l)).length > 3)
check('图片文件仍在（后面要给模型看）', (short.images ?? []).every((f) => fs.existsSync(f)))
await new Promise((r) => setTimeout(r, 1500))

console.log('\n[3] 长视频（>3 分钟）走下载抽帧')
const long = await buildVideoContext('https://www.bilibili.com/video/BV1GJ411x7h7/', base)
const longLine = (long.block || '').match(/画面：.*/)?.[0] ?? ''
check('取到', long.ok, long.error || '')
check('画面行写的是下载抽帧', /按时间均匀抽了/.test(longLine), longLine)
await new Promise((r) => setTimeout(r, 1500))

console.log('\n[4] 只有标题时的兜底')
const byTitle = await buildVideoContext('【我的小鲸鱼死了.......-哔哩哔哩】', { ...base, withFrames: false })
check('按标题找到视频', byTitle.ok, byTitle.error || '')
check('标题匹配正确', /小鲸鱼/.test(byTitle.meta?.title ?? ''), byTitle.meta?.title ?? '')

console.log('\n[5] 不该触发的情况')
const notVideo = await buildVideoContext('今天中午吃什么', { ...base, withFrames: false })
check('普通聊天不触发', notVideo.ok === false)

console.log('\n[6] 总开关')
fs.writeFileSync('./state/bili-off', '')
const off = await buildVideoContext('https://www.bilibili.com/video/BV1eGaz6JEJa/', base)
check('bili-off 时完全停用', off.ok === false && /停用/.test(off.error || ''), off.error || '')
fs.rmSync('./state/bili-off', { force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
