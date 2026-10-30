// 看门狗进程：独立于桥、独立于 DSH，盯着桥。
//
// 为什么必须独立：看护逻辑放进桥里，桥一死它跟着死（自己看自己没意义）。
// launch.mjs 只跑启动那一次，跑完就退出，也不能当看护。
//
// 这个进程做两件事（判据全部来自 src/bridge-watchdog.mjs，那边有回归）：
//   ① 桥死了 → 拉起（用 start.bat，它自带崩溃重启循环）
//   ② 桥活着但 dshReady=false → 那是 DSH 换端口了，**重启桥治不了**，
//      要先读 DSH 当前端口写回 config.json、再重启桥让它重新读进去
//
// 用法：
//   node watchdog.mjs            # 常驻
//   node watchdog.mjs --once     # 只探一次，打印状态后退出（排查用）
//
// 日志：state/watchdog.log（同时按天一份在 state/watchdog-YYYY-MM-DD.log）
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import { createBridgeSupervisor, readConsoleToken } from './src/bridge-watchdog.mjs'

const ROOT = '<REPO_ROOT>'
const STATE = path.join(ROOT, 'state')
const LOG_FILE = path.join(STATE, 'watchdog.log')
const once = process.argv.includes('--once')

// ── 自动拉起总开关 ────────────────────────────────────────────────────
// 关掉后：只探活、只写日志、只出快照，**绝不重启/拉起桥**。
//
// 为什么需要它：桥没跑时看门狗会 spawn('cmd.exe','/c','start','/min',...start.bat)，
// 而 `start` 本身就会新开一个控制台窗口，加上 start.bat 的 :loop 守护循环，
// 主人手动关掉桥之后会看到一串命令提示符窗口冒出来（2026-10-28 实测）。
// 主人要的是"看门狗先别自动动手"，不是"停掉看门狗"，所以探活能力要留着。
//
// ⚠ 为什么用**文件标记**而不是只靠环境变量（2026-10-28 实测踩的）：
//   `start-qq-bot.bat` 里明明 `set WATCHDOG_NO_AUTOSTART=1` 了，构造实验也证明
//   `start /min "" cmd /c "..."` 能继承，但真实启动出来的那只（12:26:35，pid 48340）
//   日志里**没有**"自动拉起已关闭"那行 —— 说明 env 在某条路径上丢了。
//   环境变量依赖"谁怎么拉起我"，这条链太长、太脆。
//   改成**先看文件**：文件在磁盘上，跟继承链无关，重启/换启动方式都不受影响。
//
// 两个开关（任一为真 = 关闭自动拉起）：
//   · state/watchdog-no-autostart  （文件，主开关，推荐）
//   · WATCHDOG_NO_AUTOSTART=1       （环境变量，兼容旧用法）
//
// 注意它和 state/bridge-stopped.json 的区别：
//   · stopped.json 是「主人命令桥停」（会显示 stoppedByHuman=true，下次启动要手动删）
//   · 这个开关是「看门狗先别动手」（不影响桥本身的启停语义）
const NO_AUTOSTART_FILE = path.join(STATE, 'watchdog-no-autostart')
function noAutostartByFile() {
  try { return fs.existsSync(NO_AUTOSTART_FILE) } catch { return false }
}
const NO_AUTOSTART = noAutostartByFile()
  || /^(1|true|yes|on)$/i.test(String(process.env.WATCHDOG_NO_AUTOSTART || ''))

// ── 整个停用（2026-10-28 主人要求：暂时用不上看门狗）────────────────────
// state/watchdog-disabled 存在 = 这只进程根本不该跑：
//   · start-qq-bot.bat 看到它就不启动（见那个 .bat）
//   · 就算有人手动 node watchdog.mjs，这里也会立刻退出，不会留一只"以为自己该干活"的常驻进程
// 要恢复：删掉那个文件。
const WATCHDOG_DISABLED_FILE = path.join(STATE, 'watchdog-disabled')
const WATCHDOG_DISABLED = (() => {
  try { return fs.existsSync(WATCHDOG_DISABLED_FILE) } catch { return false }
})()

fs.mkdirSync(STATE, { recursive: true })

function log(msg) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const line = `${stamp} ${msg}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* 日志写不进去不该影响看护 */ }
  process.stdout.write(line)
  // 按天分一份，方便回看（超过 14 天的不删，占用很小）
  try {
    const daily = path.join(STATE, `watchdog-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`)
    fs.appendFileSync(daily, line)
  } catch { /* 同上 */ }
}

// ── 找 DSH 当前端口（与 launch.mjs 同一套判据，别简化成 status < 500）──────────
//
// ⚠ 本机 8326 是 OpenAI 兼容网关，也会监听并回 401 JSON（"Missing or invalid API key"）。
// 真 DSH 的特征是：无鉴权时回 text/plain 的 `unauthorized`，或 200。
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 600 })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function apiAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/get`, { signal: AbortSignal.timeout(2000) })
    if (res.status === 200) return true
    if (res.status !== 401) return false
    const type = res.headers.get('content-type') || ''
    const body = (await res.text()).slice(0, 200)
    return type.includes('text/plain') || /unauthorized/i.test(body)
  } catch {
    return false
  }
}

function dshListeningPorts() {
  try {
    const netstat = execSync('netstat -ano', { encoding: 'utf8' })
    const tasklist = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const pids = new Set()
    for (const line of tasklist.split('\n')) {
      // 形如 "DeepSeek Harness.exe","20760","Console","1","305,208 K" —— 内存字段带逗号，不能按逗号硬拆
      const m = /"([^"]+\.exe)"\s*,\s*"(\d+)"/.exec(line)
      if (m && /DeepSeek/i.test(m[1])) pids.add(m[2])
    }
    const ports = new Set()
    for (const line of netstat.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5 || !/LISTENING/i.test(parts[3])) continue
      if (!pids.has(parts[4])) continue
      const port = Number(parts[1].split(':').pop())
      if (Number.isInteger(port)) ports.add(port)
    }
    return [...ports]
  } catch (error) {
    log(`[watchdog] 枚举 DSH 端口失败: ${error.message}`)
    return []
  }
}

/** 探测 DSH 当前 origin；找不到返回 null（DSH 没开）。 */
async function discoverOrigin() {
  for (const port of dshListeningPorts()) {
    if (await apiAlive(port)) return `http://127.0.0.1:${port}`
  }
  return null
}

/** 用 start.bat 拉起桥（它自带崩溃重启循环，比直接 node 稳）。
 *
 * ⚠ 这里会**新开一个控制台窗口**：`cmd /c start` 的 `start` 就是"开新窗口"，
 * `/min` 只是让它最小化，不是"不开"。所以没有 NO_AUTOSTART 时一定要谨慎调用。
 */
async function spawnBridge() {
  if (NO_AUTOSTART) {
    log(`[watchdog] 自动拉起已关闭（${noAutostartByFile() ? '文件 state/watchdog-no-autostart 存在' : '环境变量 WATCHDOG_NO_AUTOSTART=1'}），跳过 spawn start.bat`)
    return { started: false, reason: 'autostart-disabled' }
  }
  try {
    spawn('cmd.exe', ['/c', 'start', '/min', '', path.join(ROOT, 'start.bat')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()
    return { started: true }
  } catch (error) {
    return { started: false, reason: error.message }
  }
}

const supervisor = createBridgeSupervisor({
  dir: ROOT,
  port: 3100,
  log,
  discoverOrigin,
  spawnBridge,
  intervalMs: 15_000,
  autoRecover: !NO_AUTOSTART,
})

if (once) {
  // ⚠ --once 只做"看一眼"，**不做修复**：修复会重启桥，而重启要等 30 秒回来，
  // 那会让 --once 变成"要等半分钟的命令"（实测还会触发未完成 await 警告）。
  // 要修就正常跑常驻模式。
  const snap = supervisor.snapshot()
  const token = readConsoleToken(ROOT)
  let status = null
  try {
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) status = await res.json()
  } catch { /* 探不到就是没跑 */ }
  const origin = await discoverOrigin()
  const cfgUrl = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).dsh?.baseUrl ?? null } catch { return null }
  })()
  console.log(JSON.stringify({
    bridgeRunning: !!status,
    dshReady: status?.dshReady ?? null,
    mode: status?.mode ?? null,
    snowluma: status ? { connected: status.snowluma?.connected, online: status.snowluma?.accountOnline } : null,
    dshOrigin: origin,
    configBaseUrl: cfgUrl,
    baseUrlStale: !!(origin && cfgUrl && origin !== cfgUrl),
    stoppedByHuman: !supervisor.wantsRunning(),
    // 自动拉起开关的**来源**要能一眼看到，否则"到底为什么它没动手/动手了"查不清。
    noAutostart: {
      enabled: NO_AUTOSTART,
      byFile: noAutostartByFile(),
      byEnv: /^(1|true|yes|on)$/i.test(String(process.env.WATCHDOG_NO_AUTOSTART || '')),
      file: NO_AUTOSTART_FILE,
    },
    // 看门狗是不是整个被停用了（state/watchdog-disabled 存在）。
    // 这个和上面的 noAutostart 是两回事：停用 = 连这只进程都不该存在。
    disabled: WATCHDOG_DISABLED,
    supervisor: snap,
    hint: !status
      ? (WATCHDOG_DISABLED
        ? '桥没在跑；看门狗已整个停用（state/watchdog-disabled 存在），没有任何东西会拉起它 —— 要起就点「启动小鲸鱼」'
        : (NO_AUTOSTART
          ? `桥没在跑；自动拉起已关闭（${noAutostartByFile() ? '文件标记' : '环境变量'}），这只看门狗不会拉它`
          : '桥没在跑 → 常驻模式会拉起它'))
      : (status.dshReady === false && origin && cfgUrl === origin
        ? '桥在线、地址也是对的，但 dshReady=false → 这不是端口问题，重启桥没用，要看桥自己的日志'
        : (origin && cfgUrl && origin !== cfgUrl
          ? 'baseUrl 过期 → 常驻模式会回写并重启桥'
          : '正常')),
  }, null, 2))
  process.exit(0)
}

// ── 单实例锁 ──────────────────────────────────────────────────────────
// 为什么用锁文件而不是查进程：本机是 Windows 11，wmic 已被移除，
// tasklist 又拿不到命令行参数，认不出哪只 node 是看门狗。
// 锁里存 pid，启动时如果 pid 还活着就退出 —— 避免重复点图标起出两只。
// ── 整个停用时的行为 ──────────────────────────────────────────────────
// --once 保留诊断能力（主人想知道"现在什么状态"时还能查）；
// 常驻模式直接退出 —— 停用了就不该有一只进程在那儿假装干活。
if (WATCHDOG_DISABLED && !once) {
  log(`[watchdog] 已停用（${WATCHDOG_DISABLED_FILE} 存在），常驻模式直接退出。要恢复就删掉那个文件。`)
  process.exit(0)
}

const LOCK_FILE = path.join(STATE, 'watchdog.pid')
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true } catch { return false }
}
try {
  const old = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
  if (Number.isInteger(old) && old !== process.pid && pidAlive(old)) {
    console.log(`[watchdog] 已有实例在跑（pid=${old}），这只退出`)
    process.exit(0)
  }
  // 陈旧锁（进程已死）：往下走，覆盖它
} catch { /* 没有锁 = 第一次跑 */ }
fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8')
function releaseLockFile() {
  try {
    const cur = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
    if (cur === process.pid) fs.rmSync(LOCK_FILE, { force: true })
  } catch { /* 删不掉就算了，下次由 pid 判活 */ }
}

log(`[watchdog] 启动（pid=${process.pid}），每 15 秒探一次 http://127.0.0.1:3100`)
if (NO_AUTOSTART) {
  log('[watchdog] ⚠ 自动拉起已关闭（WATCHDOG_NO_AUTOSTART=1）：只探活、只记日志，不重启也不 spawn 桥')
}

// 启动时先探一次，顺便把 baseUrl 对齐（桥如果读的是旧地址，这一步能立刻救回来）
{
  const origin = await discoverOrigin()
  if (origin) {
    const { syncBridgeBaseUrl } = await import('./src/bridge-watchdog.mjs')
    const synced = syncBridgeBaseUrl(ROOT, origin, log)
    if (synced.changed) {
      log(`[watchdog] 启动时发现桥的 baseUrl 过期（${synced.before || '(空)'} → ${origin}），已回写；桥重启后会读到新地址`)
    }
  } else {
    log('[watchdog] 启动时没找到 DSH（可能还没开），桥会用 config.json 里的旧地址先跑')
  }
}

supervisor.start()

// 收到控制台停止信号时就写停机标记，免得看门狗把人为停的桥又拉起来
const gracefulStop = (signal) => {
  releaseLockFile()
  log(`[watchdog] 收到 ${signal}，写下停机标记后退出`)
  supervisor.markStopped(`watchdog:${signal}`)
  process.exit(0)
}
process.on('exit', releaseLockFile)
process.on('SIGINT', () => gracefulStop('SIGINT'))
process.on('SIGTERM', () => gracefulStop('SIGTERM'))

// 常驻：supervisor 的 setInterval 被 unref 了，这里必须自己撑住事件循环
setInterval(() => {}, 1 << 30)
