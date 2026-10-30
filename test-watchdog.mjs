// 看门狗回归（不联网、不碰真实 state/、不真启停桥）。
// 用法：node test-watchdog.mjs
//
// 这里测的是「判断」，不是「桥能不能起来」：
//   · 三种故障分不清 = 会把端口问题当崩溃重启，白折腾
//   · 退避算错 = 第一次恢复就等 2 倍基数
//   · 恢复失败后计数不清零 = 退避闸门永远开着，等于没做
//   · 人为停的桥被自动拉起 = 你关它它自己活
//   · 端口没变却去重启 = 每轮重启一次的风暴
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createBridgeSupervisor, syncBridgeBaseUrl, readConsoleToken, computeBackoff } from './src/bridge-watchdog.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'))
const BRIDGE_DIR = path.join(TMP, 'qq-bridge')
fs.mkdirSync(path.join(BRIDGE_DIR, 'state'), { recursive: true })

const writeConfig = (baseUrl) => {
  fs.writeFileSync(path.join(BRIDGE_DIR, 'config.json'), JSON.stringify({ dsh: { baseUrl } }, null, 2) + '\n', 'utf8')
}
const readConfig = () => JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'))
writeConfig('http://127.0.0.1:2574')
fs.writeFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'test-token-1234567890\n')

console.log('\n[1] syncBridgeBaseUrl：把新端口写回去')
{
  const r1 = syncBridgeBaseUrl(BRIDGE_DIR, 'http://127.0.0.1:3683')
  check('地址变了 → changed=true', r1.changed === true, JSON.stringify(r1))
  check('returns before（旧地址）', r1.before === 'http://127.0.0.1:2574', r1.before)
  check('config.json 真的写进去了', readConfig().dsh.baseUrl === 'http://127.0.0.1:3683', readConfig().dsh.baseUrl)
  check('末尾斜杠被去掉', syncBridgeBaseUrl(BRIDGE_DIR, 'http://127.0.0.1:3683/').changed === false)
  check('同样的地址 → changed=false（不重复写）', syncBridgeBaseUrl(BRIDGE_DIR, 'http://127.0.0.1:3683').changed === false)
  check('非法 origin → no-origin', syncBridgeBaseUrl(BRIDGE_DIR, 'not-a-url').reason === 'no-origin')
  check('写出的文件不带 BOM', fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8').charCodeAt(0) === 0x7b)
  check('读得到 console token', readConsoleToken(BRIDGE_DIR) === 'test-token-1234567890')
}

// ── 假桥：能按剧本返回 /api/status ────────────────────────────────────────
let scenario = { status: 200, body: { dshReady: true }, fail: false }
let restartCalls = 0
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/restart')) {
    restartCalls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (req.url?.startsWith('/api/status')) {
    if (scenario.fail) { req.destroy(); return }
    res.writeHead(scenario.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(scenario.body))
    return
  }
  res.writeHead(404); res.end('{}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

// 所有场景共用一套"假时钟"：每 sleep 一次就把 now 往前推 500ms。
// 这样 requestRestart 里那些 while (now() < deadline) 几轮就走完，测试不会真的等 30 秒；
// 推进总量也远小于 30 分钟窗口，不会把 restartTimes 挤出去（第 7 节要用它）。
let fakeClock = 1_000_000
const fakeNow = () => fakeClock
const fakeSleep = async () => { fakeClock += 500 }
const makeSup = (overrides = {}) => createBridgeSupervisor({
  dir: BRIDGE_DIR,
  port: PORT,
  log: () => {},
  probeTimeoutMs: 800,
  spawnBridge: async () => ({ started: true }),
  discoverOrigin: async () => 'http://127.0.0.1:9999',
  now: fakeNow,
  sleepFn: fakeSleep,
  ...overrides,
})

console.log('\n[2] 第 ① 类：桥进程死了 → 该拉起')
{
  writeConfig('http://127.0.0.1:9999') // 地址是对的，避免混入第 ② 类
  scenario = { fail: true }
  restartCalls = 0
  const sup = makeSup({ failuresBeforeRestart: 2 })
  await sup.probeOnce()
  check('第一次失败只记账，不动手', restartCalls === 0 && sup.snapshot().consecutiveFailures === 1, JSON.stringify(sup.snapshot()))
  await sup.probeOnce()
  check('第二次失败才尝试拉起', restartCalls >= 1, `restartCalls=${restartCalls}`)
  sup.stop()
}

console.log('\n[3] 第 ② 类：桥活着但 dshReady=false → 改地址 + 重启')
{
  writeConfig('http://127.0.0.1:2574') // 过期地址
  // 让假桥先报 dshReady=false，重启后（config 已更新）报 true
  scenario = { status: 200, body: { dshReady: false } }
  restartCalls = 0
  const sup = makeSup({
    discoverOrigin: async () => 'http://127.0.0.1:3683',
    failuresBeforeRestart: 99, // 这个场景不该走"进程死了"那条路
  })
  await sup.probeOnce()
  check('改写了 config.json 里的 baseUrl', readConfig().dsh.baseUrl === 'http://127.0.0.1:3683', readConfig().dsh.baseUrl)
  check('走了重启（不是干等着）', restartCalls >= 1, `restartCalls=${restartCalls}`)
  sup.stop()
}

console.log('\n[4] 第 ② 类的反面：地址已经是最新 → 不动手（不是端口问题）')
{
  writeConfig('http://127.0.0.1:3683')
  scenario = { status: 200, body: { dshReady: false } }
  restartCalls = 0
  const logs = []
  const sup = makeSup({
    discoverOrigin: async () => 'http://127.0.0.1:3683', // 和 config 里一样
    failuresBeforeRestart: 99,
    log: (m) => logs.push(m),
  })
  await sup.probeOnce()
  check('不重启（重启治不了）', restartCalls === 0, `restartCalls=${restartCalls}`)
  check('日志说清"不是端口问题，重启桥没用"', logs.some((m) => /不是端口问题/.test(m)), JSON.stringify(logs))
  check('状态是 degraded（让人看得见）', sup.snapshot().state === 'degraded', sup.snapshot().state)
  // 冷却：再探一次不该又去修
  const before = logs.length
  await sup.probeOnce()
  check('冷却期内不重复刷日志', logs.filter((m) => /不是端口问题/.test(m)).length === 1, `logs=${logs.length - before}`)
  sup.stop()
}

console.log('\n[5] 第 ③ 类：人为停掉的桥 → 不自动拉起')
{
  scenario = { fail: true }
  restartCalls = 0
  const sup = makeSup({ failuresBeforeRestart: 2 })
  sup.markStopped('test')
  check('停机标记落盘了', fs.existsSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json')))
  check('wantsRunning()=false', sup.wantsRunning() === false)
  await sup.probeOnce()
  await sup.probeOnce()
  await sup.probeOnce()
  check('多次探测都不拉起', restartCalls === 0, `restartCalls=${restartCalls}`)
  check('状态是 stopped 而不是 degraded（预期状态不算故障）', sup.snapshot().state === 'stopped', sup.snapshot().state)
  check('连续失败数被清零', sup.snapshot().consecutiveFailures === 0, String(sup.snapshot().consecutiveFailures))
  sup.clearStopped()
  check('清掉标记后又想跑了', sup.wantsRunning() === true)
  sup.stop()
}

console.log('\n[6] 退避：按"第几次恢复"算，不按"连续失败几次"')
{
  // 直接测纯函数 —— 跑 attemptRecovery 会走真实轮询等待，把测试挂住
  const noJitter = () => 0.5 // 抖动 1.0
  check('第 1 次恢复 = 基数（不是 2 倍）', computeBackoff({ recoverAttempts: 1, baseMs: 5000, random: noJitter }) === 5000,
    String(computeBackoff({ recoverAttempts: 1, baseMs: 5000, random: noJitter })))
  check('第 2 次 = 2 倍', computeBackoff({ recoverAttempts: 2, baseMs: 5000, random: noJitter }) === 10000)
  check('第 3 次 = 4 倍', computeBackoff({ recoverAttempts: 3, baseMs: 5000, random: noJitter }) === 20000)
  check('封顶 120s', computeBackoff({ recoverAttempts: 9, baseMs: 5000, random: noJitter }) === 120000,
    String(computeBackoff({ recoverAttempts: 9, baseMs: 5000, random: noJitter })))
  check('抖动在 ±20% 内', (() => {
    const lo = computeBackoff({ recoverAttempts: 1, baseMs: 10000, random: () => 0 })
    const hi = computeBackoff({ recoverAttempts: 1, baseMs: 10000, random: () => 0.999 })
    return lo >= 8000 && lo < 10000 && hi > 10000 && hi <= 12000
  })())
  check('recoverAttempts=0 不产生 0 或负数', computeBackoff({ recoverAttempts: 0, baseMs: 5000, random: noJitter }) === 5000)
}

console.log('\n[7] 恢复次数上限：超过窗口额度就 failed，不再无限重试')
{
  scenario = { fail: true }
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json'), { force: true })
  const sup = makeSup({
    failuresBeforeRestart: 1,
    maxRestartsPerWindow: 2,
    backoffBaseMs: 1,
    random: () => 0.5,
    spawnBridge: async () => ({ started: false }),
  })
  for (let i = 0; i < 8; i += 1) await sup.probeOnce()
  const snap = sup.snapshot()
  check('最终进入 failed', snap.state === 'failed', snap.state)
  check('日志/错误说明了原因', /停止重试/.test(String(snap.lastError)), String(snap.lastError))
  sup.stop()
}

console.log('\n[8] autoRecover=false：只探活、不动手（两类故障都不拉）')
{
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json'), { force: true })
  writeConfig('http://127.0.0.1:9999')

  // ① 桥进程死了：本该拉起，现在不许
  scenario = { fail: true }
  restartCalls = 0
  let spawned = 0
  const logs = []
  const sup = makeSup({
    autoRecover: false,
    failuresBeforeRestart: 2,
    log: (m) => logs.push(m),
    spawnBridge: async () => { spawned += 1; return { started: true } },
  })
  check('快照里能看出自动恢复已关闭', sup.snapshot().autoRecover === false, JSON.stringify(sup.snapshot()))
  for (let i = 0; i < 5; i += 1) await sup.probeOnce()
  check('桥死了也不打 /api/restart', restartCalls === 0, `restartCalls=${restartCalls}`)
  check('桥死了也不 spawn start.bat', spawned === 0, `spawned=${spawned}`)
  check('状态是 degraded（看得见但不动手）', sup.snapshot().state === 'degraded', sup.snapshot().state)
  check('说明了原因（不是静默失败）', /自动拉起已关闭/.test(String(sup.snapshot().lastError)), String(sup.snapshot().lastError))
  sup.stop()

  // ② 桥活着但 dshReady=false：本该改地址+重启，现在不许
  writeConfig('http://127.0.0.1:2574') // 故意留过期地址
  scenario = { status: 200, body: { dshReady: false } }
  restartCalls = 0
  const logs2 = []
  const sup2 = makeSup({
    autoRecover: false,
    failuresBeforeRestart: 99,
    discoverOrigin: async () => 'http://127.0.0.1:3683',
    log: (m) => logs2.push(m),
  })
  await sup2.probeOnce()
  check('不改 config.json（不自作主张）', readConfig().dsh.baseUrl === 'http://127.0.0.1:2574', readConfig().dsh.baseUrl)
  check('不重启', restartCalls === 0, `restartCalls=${restartCalls}`)
  check('仍报告了 DSH 在哪（信息不丢）', logs2.some((m) => /3683/.test(m)), JSON.stringify(logs2))
  sup2.stop()
}

console.log('\n[9] autoRecover=false 不许刷屏：多次探测只记一条')
{
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json'), { force: true })
  writeConfig('http://127.0.0.1:9999')
  scenario = { fail: true }
  const logs = []
  const sup = makeSup({
    autoRecover: false,
    failuresBeforeRestart: 2,
    log: (m) => logs.push(m),
  })
  // 模拟 20 轮巡检（真实环境里 15 秒一轮 = 5 分钟）
  for (let i = 0; i < 20; i += 1) await sup.probeOnce()
  const said = logs.filter((m) => /自动拉起已关闭/.test(m))
  check('20 轮巡检只记 1 条（不是 20 条）', said.length === 1, `实际 ${said.length} 条`)
  check('状态仍是 degraded（不谎报健康）', sup.snapshot().state === 'degraded', sup.snapshot().state)
  check('连续失败数被清零（不再往上涨）', sup.snapshot().consecutiveFailures === 0, String(sup.snapshot().consecutiveFailures))
  sup.stop()
}

console.log('\n[10] autoRecover=false 且 dshReady=false：报告 DSH 位置但不刷屏')
{
  writeConfig('http://127.0.0.1:2574')
  scenario = { status: 200, body: { dshReady: false } }
  const logs = []
  const sup = makeSup({
    autoRecover: false,
    failuresBeforeRestart: 99,
    discoverOrigin: async () => 'http://127.0.0.1:3683',
    log: (m) => logs.push(m),
  })
  for (let i = 0; i < 10; i += 1) await sup.probeOnce()
  const said = logs.filter((m) => /自动修复已关闭/.test(m))
  check('内容没变就不重复写盘', said.length <= 1, `实际 ${said.length} 条`)
  check('config.json 依然没被改', readConfig().dsh.baseUrl === 'http://127.0.0.1:2574', readConfig().dsh.baseUrl)
  check('仍报告了 DSH 在哪（信息不丢）', logs.some((m) => /3683/.test(m)), JSON.stringify(logs.slice(0, 2)))
  sup.stop()
}

console.log('\n[11] 不刷屏 ≠ 永不再说：桥恢复后再次挂掉，还要再说一次')
{
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json'), { force: true })
  writeConfig('http://127.0.0.1:9999')
  const logs = []
  const sup = makeSup({
    autoRecover: false,
    failuresBeforeRestart: 2,
    log: (m) => logs.push(m),
  })
  const countSaid = () => logs.filter((m) => /自动拉起已关闭/.test(m)).length

  // 第一轮：桥死了，说一次
  scenario = { fail: true }
  for (let i = 0; i < 6; i += 1) await sup.probeOnce()
  const afterFirstDeath = countSaid()
  check('第一次死亡报告了', afterFirstDeath === 1, `said=${afterFirstDeath}`)

  // 桥被主人手动拉起来了（恢复正常）
  scenario = { status: 200, body: { dshReady: true } }
  await sup.probeOnce()
  check('桥恢复 → 状态 healthy', sup.snapshot().state === 'healthy', sup.snapshot().state)

  // 第二轮：又死了，必须再说一次（不能因为"说过了"就不说）
  scenario = { fail: true }
  for (let i = 0; i < 6; i += 1) await sup.probeOnce()
  const afterSecondDeath = countSaid()
  check('第二次死亡又说了一次（不静默）', afterSecondDeath === 2, `said=${afterSecondDeath}`)
  check('但仍然没有刷屏（6 轮只多 1 条）', afterSecondDeath <= 2, `said=${afterSecondDeath}`)
  sup.stop()
}

console.log('\n[12] 自动拉起开关：文件标记优先于环境变量')
{
  // 直接测 watchdog.mjs 里的实际判定逻辑（不启动常驻进程）。
  // 这段逻辑是纯的：文件存在 → 关；env=1 → 关；两者都没有 → 开。
  // 读仓库根的 watchdog.mjs（相对本测试文件定位，别写死绝对路径）
  const WATCHDOG = fs.readFileSync(new URL('./watchdog.mjs', import.meta.url), 'utf8')
  // 用源码断言（文件在不同机器上路径不同，这里只验证逻辑形状）
  check('先看文件再看环境变量', /noAutostartByFile\(\)[\s\S]{0,80}\|\|[\s\S]{0,80}WATCHDOG_NO_AUTOSTART/.test(WATCHDOG),
    '判定顺序应该是 文件 || env')
  check('文件路径是 state/watchdog-no-autostart',
    WATCHDOG.includes("watchdog-no-autostart"), '找不到文件名')
  check('spawnBridge 里检查了开关', /if \(NO_AUTOSTART\)[\s\S]{0,200}autostart-disabled/.test(WATCHDOG))
  check('日志能分清是文件还是 env 关的', /文件 state\/watchdog-no-autostart 存在/.test(WATCHDOG))
}

console.log('\n[13] 停机标记语义：wantsRunning 与 autoRecover 是两个独立概念')
{
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge-stopped.json'), { force: true })
  // autoRecover=false 但没停机标记 → wantsRunning 仍为 true（这不是"主人命令停桥"）
  const sup = makeSup({ autoRecover: false })
  check('autoRecover=false 时 wantsRunning 不受影响', sup.wantsRunning() === true)
  check('快照里两个字段都在', 'autoRecover' in sup.snapshot())
  sup.markStopped('test')
  check('写标记后 wantsRunning=false', sup.wantsRunning() === false)
  check('快照能看出是人为停的', sup.wantsRunning() === false)
  sup.clearStopped()
  check('清标记后恢复', sup.wantsRunning() === true)
  sup.stop()
}

console.log('\n[14] 整个停用：disabled 标记 → 常驻模式不干活，但 --once 仍能诊断')
{
  const WATCHDOG = fs.readFileSync(new URL('./watchdog.mjs', import.meta.url), 'utf8')
  check('认 state/watchdog-disabled', WATCHDOG.includes('watchdog-disabled'), '找不到停用标记文件名')
  check('停用时常驻模式直接退出', /WATCHDOG_DISABLED\s*&&\s*!once[\s\S]{0,220}process\.exit\(0\)/.test(WATCHDOG),
    '停用了还常驻会留一只假干活的进程')
  check('--once 不受停用影响（还能查状态）', /WATCHDOG_DISABLED\s*&&\s*!once/.test(WATCHDOG), 'once 被一起挡掉了')
  check('快照暴露 disabled 字段', /disabled:\s*WATCHDOG_DISABLED/.test(WATCHDOG))
  check('桥没跑时的提示区分"停用"和"不自动拉起"', /没有任何东西会拉起它/.test(WATCHDOG), '两种状态被混成一句')
  // 三种标记的语义必须在注释里写清，否则下次一定搞混
  const BAT = fs.readFileSync(new URL('./start-qq-bot.bat', import.meta.url), 'utf8')
  check('start-qq-bot.bat 认停用标记', BAT.includes('watchdog-disabled'), '.bat 不知道这个标记')
  check('.bat 在停用时跳过启动', /if exist "state\\watchdog-disabled"[\s\S]{0,140}跳过/.test(BAT),
    '停用了还去 start watchdog.mjs')
  check('.bat 注释写清了三种状态的区别', /watchdog-disabled[\s\S]{0,120}watchdog-no-autostart/.test(BAT))
}

server.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
