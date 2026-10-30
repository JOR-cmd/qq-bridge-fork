// 验证动图压缩链路（真实跑一遍，不看日志猜）。
// 用法：node scripts/check-media.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { normalizeImageForModel } from '../src/media-normalize.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const ffmpegPath = cfg.socialV2?.voice?.ffmpegPath
const tmpDir = path.join(ROOT, 'state', 'media-tmp')

console.log('ffmpegPath:', ffmpegPath, fs.existsSync(ffmpegPath) ? '✓存在' : '✗缺失')
console.log('tmpDir:', tmpDir)
console.log()

// 造一个 ~1.3MB 的动图（和日志里失败的那个量级一致）
const work = fs.mkdtempSync(path.join(tmpDir, '_check-'))
const gifPath = path.join(work, 'big.gif')
execFileSync(ffmpegPath, [
  '-v', 'error', '-y', '-f', 'lavfi',
  '-i', 'testsrc2=duration=2:size=420x420:rate=24',
  '-vf', 'format=rgb24', gifPath,
])
const gif = fs.readFileSync(gifPath)
console.log(`造出测试动图: ${(gif.length / 1024 / 1024).toFixed(2)} MB`)

// 走桥用的那个函数
const out = await normalizeImageForModel(gif, 'image/gif', {
  enabled: true,
  maxModelBytes: 1024 * 1024,
  maxLongEdge: 1280,
  gifFrames: 6,
  gifTile: 240,
  timeoutMs: 25000,
  tmpDir,
  ffmpegPath,
  label: '测试动图',
})

console.log('\n结果:')
console.log('  ok:', out.ok)
if (out.ok) {
  console.log('  mimeType:', out.mimeType)
  console.log('  输出大小:', `${(out.buffer.length / 1024).toFixed(1)} KB`)
  console.log('  note:', out.note ?? '(无)')
} else {
  console.log('  error:', out.error)
}

fs.rmSync(work, { recursive: true, force: true })
process.exit(out.ok ? 0 : 1)
