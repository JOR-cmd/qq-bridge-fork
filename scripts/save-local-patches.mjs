// 把本机对 qq-bridge 的改动快照到 patches/，方便重装仓库后一键恢复。
// 用法：node scripts/save-local-patches.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'patches')
const FILES = [
  'src/bridge.js',
  'src/recall.mjs',
  // 中文时间说法解析（本地化自 dsh-silicon 的 parse_when，2026-10-30）：
  // 让 recall 能把「上周三」「8月3号」「三天前」切成精确时间窗。
  // 漏了这个文件 → recall.mjs 会 import 失败 → 整个冷存储检索静默失效。
  'src/when-cn.mjs',
  'test-when-cn.mjs',
  'test-recall-strip.mjs',
  // 情绪层（PAD 三维 + 标签 + 快速衰减，2026-10-30）：
  // 结构本地化自 memory-brain 的 emotion.py，词表按她的对话重新配过。
  // 漏了这个文件 → bridge.js 会 import 失败 → 整条启动链路崩掉。
  'src/emotion-pad.mjs',
  'test-emotion-pad.mjs',
  // 分词修复 + 话题标签（"图谱"极简版，2026-10-30）。
  // 漏了 topic-tags.mjs → archive-store 会 import 失败 → 整个存档/检索链路崩掉。
  'src/topic-tags.mjs',
  'test-tokenize.mjs',
  'test-topic-tags.mjs',
  'scripts/backfill-importance.mjs',
  'scripts/backfill-tags.mjs',
  'scripts/measure-retrieval-gap.mjs',
  'scripts/analyze-graph-value.mjs',
  'scripts/analyze-vector-value.mjs',
  'scripts/analyze-threshold.mjs',
  'scripts/verify-tokenization-fix.mjs',
  'scripts/verify-deployment.mjs',
  // importance 判据的唯一实现（archive-store 的新消息入库 + 回填脚本共用）。
  // 漏了它 → archive-store import 失败 → 存档链路整体崩。
  'src/importance-estimate.mjs',
  'scripts/check-topic-tags-quality.mjs',
  // 记忆分层 / 衰减（2026-10-30）：migration、每日维护、验证脚本。
  // 漏了 decay-memory.mjs → 桥接的每日维护子进程会 ENOENT，衰减永不执行（静默失效）。
  'scripts/migrate-memory-fields.mjs',
  'scripts/decay-memory.mjs',
  'scripts/verify-maintenance-refs.mjs',
  'scripts/verify-bridge-loads.mjs',
  'scripts/verify-pad-rules.mjs',
  'scripts/verify-pad-local.mjs',
  'scripts/verify-emotion-e2e.mjs',
  'src/archive-store.mjs',
  'src/covenant-store.mjs',
  'src/covenant-inject.mjs',
  'src/covenant-redact.mjs',
  'src/covenant-facts.mjs',
  'src/bridge-watchdog.mjs',
  'watchdog.mjs',
  'preview-covenant.mjs',
  // 目的引擎（本地新增，2026-10-28）：给主动机会一个"她想说什么"的输入。
  'src/intent-engine.mjs',
  'scripts/preview-intent.mjs',
  'scripts/check-familiarity.mjs',
  'scripts/check-idempotent.mjs',
  'scripts/check-media.mjs',
  'scripts/check-media-fail.mjs',
  'scripts/check-intent-read.mjs',
  'scripts/check-advance.mjs',
  'scripts/check-advance-branches.mjs',
  'scripts/check-covenant-privacy.mjs',
  'scripts/check-covenant-redact.mjs',
  'scripts/check-covenant-bound.mjs',
  'scripts/bench-openloops.mjs',
  'scripts/check-prompt-budget.mjs',
  'scripts/check-covenant-compress2.mjs',
  'scripts/check-covenant-compress.mjs',
  'scripts/check-double-derive.mjs',
  // 对话收尾（本地新增，2026-10-28）：给她一个"这段聊完了"的中间状态。
  'src/closure-engine.mjs',
  'scripts/preview-closure.mjs',
  'src/archive-backup.mjs',
  'src/mcp-snowluma-safe.js',
  'src/bili-video.mjs',
  'src/bili-storyboard.mjs',
  'src/bili-title.mjs',
  'src/bili-write-grant.mjs',
  'scripts/archive.mjs',
  'scripts/fix-covenant-dupes.mjs',
  'start.bat',
  'start-qq-bot.bat', // ⚠ 里面有 WATCHDOG_NO_AUTOSTART=1（自动拉起默认关闭），丢了会退回旧行为
  'launch.mjs',
  // ⚠ 仿真提示词的真身在 ~/.dsh/plugins/qq-agent-presets/presets/*.patch.yml，
  // 不在本仓库里；这里存的是一份**副本**，重装后要手动 cp 回去（见 LOCAL-NOTES.md）。
  // 曾经踩过：以为改 qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml 就生效了，
  // 实际 DSH 读的是 profile 里那份 patch.yml，白改一场。
  'dsh/agent-presets/qq-chat-v2.patch.yml',
  // ⚠️ 回归脚本也纳入：重装仓库后要能立刻验证，而不是重新写一遍测试。
  // 它们不联网、不碰真实 state/，是安全的本地资产。
  'test-watchdog.mjs',
  'test-covenant.mjs',
  'test-covenant-facts.mjs',
  'test-covenant-compress.mjs',
  'test-bili-v2.mjs',
  'test-grant.mjs',
  'test-intent.mjs',
  'test-intent-integration.mjs',
  'test-closure.mjs',
  'test-closure-integration.mjs',
  // 2026-10-30 晚新增（A/B/D/E/F 的回归）。漏了它们 = 重装后这几个漏洞没有守卫。
  'test-recall-params.mjs',
  'test-memory-scheduler.mjs',
  'test-covenant-tier.mjs',
  'test-covenant-mark-order.mjs',
  'test-decay-idempotent.mjs',
  // ⚠️ 人格卡（roles/*.md）**故意不纳入补丁快照**：
  // 那是主人自己改、自己命名的内容，整份覆盖会把他的改动盖掉。
  // 曾经把 roles/小鲸鱼-主人.md 列进来过一次，后来主人把文件改名，快照就指着不存在的文件。
  'LOCAL-NOTES.md',
  // 交接文档（2026-10-29 / 2026-10-30）—— 给下一个会话读的，重装仓库后要有
  'HANDOFF-2026-10-29.md',
  'HANDOFF-2026-10-30.md',
]

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const manifest = { baseVersion: pkg.version, savedAt: new Date().toISOString(), files: [] }
for (const rel of FILES) {
  const src = path.join(ROOT, rel)
  if (!fs.existsSync(src)) {
    console.log(`跳过（不存在）: ${rel}`)
    continue
  }
  const buf = fs.readFileSync(src)
  const dest = path.join(OUT, 'files', rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
  manifest.files.push({ path: rel, bytes: buf.length, sha256: sha(buf) })
  console.log(`快照: ${rel} (${buf.length} 字节)`)
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`\n基线版本 ${manifest.baseVersion}，共 ${manifest.files.length} 个文件 → patches/`)
