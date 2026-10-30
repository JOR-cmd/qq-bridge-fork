// 一键启动：SnowLuma → 等 DSH → 对齐 baseUrl → 起桥接 → 对齐运行模式
// 桌面快捷方式「启动小鲸鱼」调用 start-qq-bot.bat，由它执行本文件。
import fs from 'node:fs'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'

const ROOT = '<REPO_ROOT>'
const LOG = `${ROOT}/state/launcher.log`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const line = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${m}\n`
  try { fs.appendFileSync(LOG, line) } catch {}
  // 同时打到控制台，双击启动时窗口里能看见进度
  process.stdout.write(line)
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 800 })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function apiAlive(port) {
  // 注意：本机 8326 是 OpenAI 兼容网关，也会监听并返回 401 JSON（"Missing or invalid API key"）。
  // 真 DSH 的特征是无鉴权时回 text/plain 的 `unauthorized`，鉴权通过时回 200。
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/get`, { signal: AbortSignal.timeout(2500) })
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
      const match = /"([^"]+\.exe)"\s*,\s*"(\d+)"/.exec(line)
      if (match && /DeepSeek/i.test(match[1])) pids.add(match[2])
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
    log(`枚举端口失败: ${error.message}`)
    return []
  }
}

async function main() {
  log('— 启动 —')

  if (!(await portOpen(5099))) {
    log('SnowLuma 未运行，启动 launcher.bat')
    spawn('cmd.exe', ['/c', 'start', '/min', '', 'D:\\SnowLuma\\launcher.bat'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()
    for (let i = 0; i < 120; i += 1) {
      await sleep(1000)
      if (await portOpen(5099)) break
    }
  }
  log(`SnowLuma: ${(await portOpen(5099)) ? '就绪' : '未就绪'}`)

  // DSH 桌面版常常是用户登录之后才手动打开的。最多等 6 小时，每 30 秒探一次；
  // 每 20 次（约 10 分钟）才写一行日志，避免刷屏。
  let baseUrl = null
  for (let attempt = 0; attempt < 720 && !baseUrl; attempt += 1) {
    for (const port of dshListeningPorts()) {
      if (await apiAlive(port)) { baseUrl = `http://127.0.0.1:${port}`; break }
    }
    if (baseUrl) break
    if (attempt > 0 && attempt % 20 === 0) log(`仍在等 DSH…（已等 ${Math.round(attempt / 2)} 分钟）`)
    await sleep(30000)
  }

  if (!baseUrl) {
    log('没找到 DSH API 端口，放弃本轮（下次登录再试）')
    return
  }
  log(`DSH: ${baseUrl}`)

  const cfgPath = `${ROOT}/config.json`
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (cfg.dsh.baseUrl !== baseUrl) {
    log(`baseUrl ${cfg.dsh.baseUrl} → ${baseUrl}`)
    cfg.dsh.baseUrl = baseUrl
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  }

  if (await portOpen(3100)) {
    log('桥接已在运行')
  } else {
    // 用 start.bat 而不是直接 node：它带崩溃自动重启（5 秒后拉起），窗口最小化。
    spawn('cmd.exe', ['/c', 'start', '/min', '', 'D:\\DSH\\work\\qq-bridge\\start.bat'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()
    log('桥接已通过 start.bat 启动（带守护）')

    for (let i = 0; i < 40; i += 1) {
      await sleep(1000)
      if (await portOpen(3100)) break
    }
    log(`桥接: ${(await portOpen(3100)) ? '就绪' : '未就绪'}`)
  }

  // 模式对齐：DSH 重启后 qq-mode 设置可能回到插件默认值（chat），
  // 以 state/mode.json 为准（控制台每次切模式都会写它）重新断言一次。
  try {
    const token = fs.readFileSync(`${ROOT}/state/console-token`, 'utf8').trim()
    const wanted = JSON.parse(fs.readFileSync(`${ROOT}/state/mode.json`, 'utf8')).mode
    const status = await fetch('http://127.0.0.1:3100/api/status', {
      headers: { 'x-console-token': token }, signal: AbortSignal.timeout(5000),
    }).then((r) => r.json())
    if (wanted && status.mode !== wanted) {
      log(`模式不一致（实际 ${status.mode}，期望 ${wanted}），按 state/mode.json 重新设置`)
      await fetch('http://127.0.0.1:3100/api/mode', {
        method: 'POST',
        headers: { 'x-console-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: wanted }),
        signal: AbortSignal.timeout(10000),
      })
      log('模式已对齐')
    } else {
      log(`模式已是 ${status.mode}`)
    }
  } catch (error) {
    log(`模式对齐跳过: ${error.message}`)
  }

  // 冷存储：把当前窗口里的消息追加到 state/archive/（幂等，重复的不会写）
  // 放在最后，失败不影响服务启动。
  try {
    const out = execSync(`"${process.execPath}" scripts/archive.mjs`, {
      cwd: ROOT, encoding: 'utf8', timeout: 20000,
    }).trim()
    log(`冷存储: ${out.split('\n')[0]}`)
  } catch (error) {
    log(`冷存储跳过: ${error.message}`)
  }
}

await main()
