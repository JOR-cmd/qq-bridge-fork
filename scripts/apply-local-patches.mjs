// 把 patches/ 里的文件恢复到本机（重装/升级 qq-bridge 之后跑这个）。
//
// 用法：
//   node scripts/apply-local-patches.mjs --check   只检查，不写文件
//   node scripts/apply-local-patches.mjs           写回并校验
//
// 注意：它恢复的是我们改过的整份文件（基线见 MANIFEST.json 的 baseVersion）。
// 如果上游版本变了，bridge.js 会被整份覆盖成基线版本 —— 这正是"补丁"的代价，
// 所以脚本会把版本不一致这件事明确吼出来。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'patches')
const checkOnly = process.argv.includes('--check')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

// 恢复后用来确认"确实改上了"的标记（grep 命中即通过）
const MARKERS = {
  'src/bridge.js': ['formatCovenantLineV2', 'startArchiveFlusher', 'recallSnippets', 'ingestCovenantLetter'],
  'src/recall.mjs': ['queryTokens', 'recallSnippets'],
  'src/archive-store.mjs': ['ArchiveStore'],
  'src/covenant-store.mjs': ['CovenantStore', 'parseCovenantLetter', 'shouldInviteCovenant', 'retireMark', 'markSupportedBy', 'checkMark'],
  'src/covenant-facts.mjs': ['collectMarkFacts', 'markKeywords', 'formatMarkFacts'],
  'src/bridge-watchdog.mjs': ['createBridgeSupervisor', 'syncBridgeBaseUrl', 'computeBackoff'],
  'watchdog.mjs': ['discoverOrigin', 'spawnBridge'],
  'src/mcp-snowluma-safe.js': ['qq_covenant_mark', 'qq_covenant_read', 'qq_covenant_retire', 'qq_covenant_settle'],
  'scripts/fix-covenant-dupes.mjs': ['normalizeMarkText'],
  'src/archive-backup.mjs': ['backupDaily'],
  'scripts/archive.mjs': ['ArchiveStore'],
  'start.bat': ['state\\bridge.out.log'],
  'launch.mjs': ['冷存储', 'archive.mjs'],
}

if (!fs.existsSync(path.join(SRC, 'MANIFEST.json'))) {
  console.error('没有找到 patches/MANIFEST.json —— 先跑 node scripts/save-local-patches.mjs')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'MANIFEST.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

console.log(`补丁基线: ${manifest.baseVersion}（保存于 ${manifest.savedAt.slice(0, 10)}）`)
console.log(`当前版本: ${pkg.version}`)
if (pkg.version !== manifest.baseVersion) {
  console.warn('⚠️  版本不一致：整份覆盖可能丢掉上游的新改动，请先确认再继续')
}
console.log('')

let applied = 0
let skipped = 0
let failed = 0

for (const entry of manifest.files) {
  const from = path.join(SRC, 'files', entry.path)
  const to = path.join(ROOT, entry.path)
  if (!fs.existsSync(from)) {
    console.log(`✗ 补丁缺失: ${entry.path}`)
    failed += 1
    continue
  }
  const buf = fs.readFileSync(from)
  const current = fs.existsSync(to) ? fs.readFileSync(to) : null
  if (current && sha(current) === sha(buf)) {
    console.log(`= 已是最新: ${entry.path}`)
    skipped += 1
    continue
  }
  if (checkOnly) {
    console.log(`… 待恢复: ${entry.path}（${current ? '内容不同' : '文件不存在'}）`)
    applied += 1
    continue
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, buf)
  console.log(`✓ 已恢复: ${entry.path}`)
  applied += 1
}

// 校验标记
if (!checkOnly) {
  console.log('\n校验:')
  for (const [rel, markers] of Object.entries(MARKERS)) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const missing = markers.filter((m) => !text.includes(m))
    console.log(missing.length ? `  ✗ ${rel} 缺: ${missing.join(', ')}` : `  ✓ ${rel}`)
    if (missing.length) failed += 1
  }
}

console.log(`\n${checkOnly ? '[检查模式] ' : ''}恢复 ${applied} / 已最新 ${skipped} / 失败 ${failed}`)
if (!checkOnly && applied > 0) console.log('改的是 src/ 下的代码 → 需要重启桥接生效（双击桌面「启动小鲸鱼」）。')
process.exit(failed ? 1 : 0)
