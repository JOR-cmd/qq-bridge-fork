// 验证失败路径诊断：让 ffmpeg 真的失败，确认错误信息里有真实原因。
// 用法：node scripts/check-media-fail.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
process.chdir(ROOT) // 桥的 cwd 就是项目根

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const ffmpegPath = cfg.socialV2?.voice?.ffmpegPath
const tmpDir = path.join(ROOT, 'state', 'media-tmp')

const dir = fs.mkdtempSync(path.join(tmpDir, '_failtest-'))
const reportFile = path.join(dir, 'ffmpeg-report.log')
const outFile = path.join(dir, 'strip.jpg')
const missing = path.join(dir, 'does-not-exist.gif')

// 换算成相对 cwd（FFREPORT 只认这个）
const rel = path.relative(process.cwd(), reportFile).split(path.sep).join('/')
console.log('工作区:', dir)
console.log('FFREPORT 相对路径:', rel)

const args = [
  '-v', 'error', '-report', '-y', '-i', missing,
  '-filter_complex', '[0:v]fps=2,scale=240:-1,tile=3x2:padding=4:margin=4:color=white[out]',
  '-map', '[out]', '-frames:v', '1', '-q:v', '4', outFile,
]

const code = await new Promise((resolve) => {
  const env = { ...process.env, FFREPORT: `file=${rel}` }
  const c = spawn(ffmpegPath, args, { windowsHide: true, stdio: 'ignore', env, cwd: ROOT })
  c.on('close', resolve)
})

console.log('\nffmpeg 退出码:', code, '(非 0 = 确实失败)')
console.log('report 文件生成:', fs.existsSync(reportFile))

function readTail(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const lines = raw.split('\n').map((s) => s.trim())
      .filter((s) => /error|Error|failed|Permission|denied|Invalid|No such|not found/i.test(s))
    return lines.slice(-2).join(' | ').slice(0, 260)
  } catch { return '' }
}

const detail = readTail(reportFile)
console.log('提取到的真实原因:', detail || '（空）')
console.log()
console.log(detail ? '✓ 诊断可用：能带出 ffmpeg 的原话' : '✗ 诊断失效：只有退出码')

fs.rmSync(dir, { recursive: true, force: true })
for (const f of fs.readdirSync(ROOT).filter((n) => /^ffmpeg-.*\.log$/i.test(n))) {
  fs.rmSync(path.join(ROOT, f), { force: true })
  console.log(`(清理误写到项目根的 ${f})`)
}
process.exit(detail ? 0 : 1)
