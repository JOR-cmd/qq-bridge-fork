// qq-bridge 的看门狗：只做三件事 —— 探测、判断该不该动手、动手时别把自己打爆。
//
// 为什么需要这一层（照 dsh-world 的 src/ecosystem/qq/supervisor.ts，MIT）：
//   桥是独立进程（`start.bat` 里 spawn、detached）。除了启动那一刻的 launch.mjs 之外，
//   这边对它一无所知。三种故障在界面上长得一模一样 —— QQ 不说话了：
//
//     ① 进程死了            → probe 失败 → 该重新拉起
//     ② 进程活着、连不上 DSH → probe 成功但 dshReady=false → **重启桥没用**
//                             那是 config.json 里的 baseUrl 过期了（DSH 每次重启换端口），
//                             要先 syncEndpoint 回写新地址、再重启桥让它重新读进去。
//     ③ 用户主动关的         → 不该自动拉起，否则你关它它 5 秒后又活了
//
//   第 ② 类是 dsh-world 的原话：「2026-10-26 那次『链路死了四小时』就是这么来的」——
//   地址旧了不会报错，只会静静连不上，看起来和桥本身挂掉一模一样。
//   我们这边的对应事实：`start.bat` 崩溃 5 秒自动拉起，那条路径**不经过 launch.mjs**，
//   所以它读的是 config.json 里那个可能已经过期的 baseUrl。
//
// 它不接管桥的启停实现（那是 start.bat / launch.mjs 的事），也不碰任何业务逻辑。
//
// ⚠ 与上游的差异（我们的桥没有 /api/stop、也没有 intent 文件）：
//   · 上游用 `bridge.intent.json` 表达「用户想不想让它跑」，我们改用**锁文件 + 停机标记**：
//     停机标记 state/bridge-stopped.json 由看门狗自己写（见 markStopped），
//     存在就表示"上次是人为停的，别自动拉起"。
//   · 上游用 `/api/stop` 真停；我们的 `/api/restart` 是 process.exit(0)，靠守护循环回来。
//     所以这里的 "restart" = POST /api/restart（若守护窗口还在，它会自己回来）
//     加一层兜底：等不到回来就 spawn start.bat。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_FAILURES_BEFORE_RESTART = 2;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const MAX_BACKOFF_MS = 120_000;
const RESTART_WINDOW_MS = 30 * 60 * 1000;
/** 拉起后等多久算"起来了"。桥要连 SnowLuma + DSH，比上游慢，给 30 秒。 */
const START_WAIT_MS = 30_000;
/** 重启后等端口消失的上限。 */
const STOP_WAIT_MS = 12_000;

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export function readConsoleToken(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把 DSH 当前的地址写回桥的 config.json（`dsh.baseUrl`）。
 *
 * 为什么这件事必须有人做：DSH 每次重启都换端口，桥的 baseUrl 是写死的值，
 * 而过期之后**没有任何东西会抗议** —— `dshReady` 只是变成 false，事件流每 30 秒重连一次、
 * 一帧都收不到。看起来和桥挂了完全一样。
 *
 * @returns {{changed:boolean, reason?:string, baseUrl?:string, before?:string}}
 */
export function syncBridgeBaseUrl(dir, origin, log = () => {}) {
  const url = typeof origin === 'string' ? origin.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^/]/i.test(url)) return { changed: false, reason: 'no-origin' };
  const file = path.join(dir, 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { changed: false, reason: `config.json 读不到：${messageOf(error)}` };
  }
  config.dsh = config.dsh ?? {};
  const before = typeof config.dsh.baseUrl === 'string' ? config.dsh.baseUrl.trim() : '';
  if (before === url) return { changed: false, baseUrl: url, before };
  config.dsh.baseUrl = url;
  // 不带 BOM 写：桥按 utf-8-sig 读，别的工具会被 BOM 卡住
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  log(`[watchdog] 桥的 DSH 端点已更新：${before || '(空)'} → ${url}`);
  return { changed: true, baseUrl: url, before };
}


/**
 * 退避时长：按「第几次发起恢复」算，不按「连续探测失败几次」算。
 *
 * 为什么：阈值是 2（连续失败 2 次才动手），如果拿探测次数去套指数，
 * 第一次恢复就先等 2 倍基数，等于白等一轮（上游注释里明确写过这个坑）。
 * recoverAttempts 是 1-based。
 */
export function computeBackoff({ recoverAttempts = 1, baseMs = DEFAULT_BACKOFF_BASE_MS, random = Math.random } = {}) {
  const raw = baseMs * 2 ** Math.min(Math.max(0, recoverAttempts - 1), 5);
  const jitter = 0.8 + random() * 0.4; // ±20%：多实例同时恢复时不至于踩同一个节奏
  return Math.min(MAX_BACKOFF_MS, Math.round(raw * jitter));
}

export function createBridgeSupervisor(options) {
  const {
    dir,
    log = () => {},
    port = 3100,
    intervalMs = DEFAULT_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    failuresBeforeRestart = DEFAULT_FAILURES_BEFORE_RESTART,
    maxRestartsPerWindow = DEFAULT_MAX_RESTARTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    discoverOrigin,      // () => Promise<string|null>  探测 DSH 当前端口
    spawnBridge,         // () => Promise<{started:boolean, reason?:string}>
    now = () => Date.now(),
    random = () => Math.random(),
    // 注入等待函数：测试里让它立即返回，否则退避会把测试挂住（最长 120s 一次）。
    sleepFn = sleep,
    // 自动恢复总开关（默认开）。关掉后只探活、只更新状态，不发起任何重启/拉起。
    // 用于主人手动关桥后不希望看门狗把桥又拉起来的场景（WATCHDOG_NO_AUTOSTART=1）。
    autoRecover = true,
  } = options;

  const base = `http://127.0.0.1:${port}`;
  const STOPPED_FILE = path.join(dir, 'state', 'bridge-stopped.json');

  let state = 'stopped';
  let consecutiveFailures = 0;
  /** 本轮连续发起恢复的次数；成功或被探到桥好了就清零。退避按它算。 */
  let recoverAttempts = 0;
  let backoffMs = 0;
  let lastError;
  let lastProbeAt;
  let lastRestartAt;
  let dshReady;
  const restartTimes = [];
  /** 端点修复的冷却截止时间：修一次（无论成败）之后在这之前不再动。 */
  let endpointRetryAfter = 0;
  /** 本轮是否已经确认过"地址没变、不是端口问题"，用于日志去重。 */
  let endpointConfirmedFresh = false;
  /** 单飞：探测和恢复共用这把锁，避免慢探测叠在恢复上。 */
  let inFlight = false;
  /** autoRecover=false 的提示是否已经记过一次（避免每 15 秒刷一条）。 */
  let autoRecoverReported = false;
  /** 上一条「自动修复已关闭」的实际内容，内容没变就不再写盘。 */
  let lastAutoRepairError;
  let timer;

  /** 「人为停的」标记：存在就不自动拉起。 */
  function markStopped(byAs = 'console') {
    try {
      fs.mkdirSync(path.dirname(STOPPED_FILE), { recursive: true });
      fs.writeFileSync(STOPPED_FILE, `${JSON.stringify({ desired: 'stopped', at: Date.now(), by: byAs }, null, 2)}\n`, 'utf8');
    } catch (error) { log(`[watchdog] 写停机标记失败：${messageOf(error)}`); }
  }
  function clearStopped() {
    try { fs.rmSync(STOPPED_FILE, { force: true }); } catch { /* 删不掉就当没标记 */ }
  }
  function wantsRunning() {
    // ⚠ 读不到标记时按「想跑」处理：未知状态不该变成永久不启动（照上游的 intent()）
    return !fs.existsSync(STOPPED_FILE);
  }

  function pruneWindow(at) {
    const cutoff = at - RESTART_WINDOW_MS;
    while (restartTimes.length > 0 && restartTimes[0] < cutoff) restartTimes.shift();
  }

  // 复用导出的纯函数，保证测试测的就是跑的那一份
  const nextBackoff = () => computeBackoff({ recoverAttempts, baseMs: backoffBaseMs, random });

  async function probe() {
    const token = readConsoleToken(dir);
    const url = `${base}/api/status${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
      if (res.status !== 200) return { ok: false, error: `status ${res.status}` };
      const body = await res.json();
      return { ok: true, body: body ?? {} };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /**
   * 第 ② 类故障的专用处理：桥活着但 dshReady=false。
   * 先回写 baseUrl，再看有没有真的变化 —— 变了才重启（没变说明不是地址问题，重启也没用）。
   * @returns {Promise<boolean>} 是否已经动过手
   */
  async function repairEndpoint() {
    // 无论结果如何，先上冷却：避免"每 15 秒重启一次桥"的风暴。
    // 冷却长度按 recoverAttempts 退避，第一次 60s，之后翻倍到最多 10 分钟。
    const cooldown = Math.min(10 * 60_000, 60_000 * 2 ** Math.min(recoverAttempts, 4));
    if (!autoRecover) {
      let origin = null;
      try { origin = await discoverOrigin(); } catch { origin = null; }
      lastError = origin
        ? `桥在线但 dshReady=false；自动修复已关闭（autoRecover=false），只报告不动手（DSH 在 ${origin}）`
        : '桥在线但 dshReady=false；自动修复已关闭（autoRecover=false），只报告不动手';
      // 同样只记一次（进冷却后本轮不会再进来，但冷却到期时会重进）
      if (lastError !== lastAutoRepairError) {
        lastAutoRepairError = lastError;
        log(`[watchdog] ${lastError}`);
      }
      endpointRetryAfter = now() + cooldown;
      return false;
    }
    let origin = null;
    try { origin = await discoverOrigin(); } catch { origin = null; }
    if (!origin) {
      lastError = '桥在线但 dshReady=false，而且找不到 DSH 当前端口（DSH 可能没开）';
      log(`[watchdog] ${lastError}`);
      endpointRetryAfter = now() + cooldown;
      return false;
    }
    const synced = syncBridgeBaseUrl(dir, origin, log);
    if (!synced.changed) {
      // config.json 里已经是最新地址 → 不是端点过期，重启桥没用。
      // 只记一次日志，别每轮刷。
      if (!endpointConfirmedFresh) {
        endpointConfirmedFresh = true;
        lastError = `桥在线、dshReady=false，且 baseUrl 已是最新（${origin}）；不是端口问题，重启桥没用`;
        log(`[watchdog] ${lastError}`);
      }
      endpointRetryAfter = now() + cooldown;
      recoverAttempts += 1;
      return false;
    }
    endpointConfirmedFresh = false;
    log(`[watchdog] baseUrl 从 ${synced.before || '(空)'} 换到 ${origin}，重启桥让它重新读进去`);
    const r = await requestRestart();
    recoverAttempts = r.restarted ? 0 : recoverAttempts + 1;
    lastRestartAt = r.restarted ? now() : lastRestartAt;
    endpointRetryAfter = now() + cooldown;
    return true;
  }

  /** 打 /api/restart。桥会 exit(0)，靠 start.bat 的守护循环回来；等不到就兜底 spawn。 */
  async function requestRestart() {
    const token = readConsoleToken(dir);
    try {
      await fetch(`${base}/api/restart${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
    } catch {
      // 它在退出路上会把连接断掉，这个报错是预期的
    }
    // 等端口消失（真的重启了）
    const stopDeadline = now() + STOP_WAIT_MS;
    while (now() < stopDeadline) {
      await sleepFn(600);
      if (!(await probe()).ok) break;
    }
    // 等它回来
    const startDeadline = now() + START_WAIT_MS;
    while (now() < startDeadline) {
      await sleepFn(800);
      if ((await probe()).ok) return { restarted: true };
    }
    // 没回来：守护窗口大概没了（被关掉/被杀），兜底自己拉
    log('[watchdog] /api/restart 后桥没回来，兜底 spawn start.bat');
    if (typeof spawnBridge === 'function') {
      const r = await spawnBridge().catch((error) => ({ started: false, reason: messageOf(error) }));
      const deadline = now() + START_WAIT_MS;
      while (now() < deadline) {
        await sleepFn(800);
        if ((await probe()).ok) return { restarted: true, viaSpawn: true };
      }
      return { restarted: false, reason: r?.reason ?? 'not-ready' };
    }
    return { restarted: false, reason: 'not-ready' };
  }

  async function attemptRecovery(at) {
    if (!autoRecover) {
      state = 'degraded';
      lastError = '自动拉起已关闭（autoRecover=false），桥没在跑但这只看门狗不会拉它';
      // ⚠ 只记一次，不要每轮都写。实测：不清零 consecutiveFailures 的话，
      // tick 每 15 秒就会再调一次这里，一天刷 8600+ 行死日志。
      // 清零 + 一个「已报告」标记，状态变了才重新说。
      consecutiveFailures = 0;
      if (!autoRecoverReported) {
        autoRecoverReported = true;
        log(`[watchdog] ${lastError}`);
      }
      return;
    }
    autoRecoverReported = false;
    if (!wantsRunning()) {
      state = 'stopped';
      log('[watchdog] 桥是人为停掉的（state/bridge-stopped.json），不自动拉起');
      return;
    }
    pruneWindow(at);
    if (restartTimes.length >= maxRestartsPerWindow) {
      state = 'failed';
      lastError = `${RESTART_WINDOW_MS / 60000} 分钟内已尝试拉起 ${restartTimes.length} 次，停止重试（修好后再手动启动）`;
      log(`[watchdog] ${lastError}`);
      return;
    }
    state = 'starting';
    log(`[watchdog] 桥连续 ${consecutiveFailures} 次探测失败，尝试拉起`);
    // ⚠ 先记一次尝试，**不管成没成**。
    // 只在成功时 push 的话，「10 分钟最多 5 次」这道闸门对**连续失败**根本不生效 ——
    // 桥一直起不来就会一直重试（只有退避在挡），等于没有额度限制。
    // （这是照上游实现时自己踩到的：它只记成功的重启，测试第 7 节把这个缺口捅出来了。）
    restartTimes.push(now());
    const r = await requestRestart();
    if (r.restarted) {
      lastRestartAt = now();
      state = 'healthy';
      consecutiveFailures = 0;
      recoverAttempts = 0;
      backoffMs = 0;
      lastError = undefined;
      log(`[watchdog] 桥已拉起${r.viaSpawn ? '（兜底 spawn）' : ''}`);
      return;
    }
    lastError = `拉起没成功：${r.reason ?? '未知原因'}`;
    // 失败：进入退避等待，期间不再尝试；等待结束才回到 degraded 让下一轮重新判定。
    // 计数必须清零 —— 否则「连续失败 N 次」这个闸门永远开着，退避等于没做（上游注释）。
    state = 'recovering';
    consecutiveFailures = 0;
    recoverAttempts += 1;
    backoffMs = nextBackoff();
    log(`[watchdog] ${lastError}；${Math.round(backoffMs / 1000)}s 后再试`);
    await sleepFn(backoffMs);
    if (state === 'recovering') state = 'degraded';
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const at = now();
      lastProbeAt = at;
      const result = await probe();
      if (result.ok) {
        consecutiveFailures = 0;
        recoverAttempts = 0;
        backoffMs = 0;
        // 桥回来了 → 重置"已报告"标记，这样它**再次**挂掉时还会说一次。
        // 不清零的话，第二次死亡是静默的（第一次说过就不再说了）。
        autoRecoverReported = false;
        lastAutoRepairError = undefined;
        dshReady = result.body.dshReady === true;
        if (dshReady) {
          state = 'healthy';
          lastError = undefined;
          endpointConfirmedFresh = false;
          return;
        }
        // 桥在跑但连不上 DSH：**重启桥治不了这个**，是 baseUrl 过期了。
        // 照上游：标 degraded 让人看得见，走专门的修复路径；而且**不能每轮都重启**，
        // 所以修完之后无论成败都进冷却，避免 15 秒一次的重启风暴。
        state = 'degraded';
        if (now() < endpointRetryAfter) {
          lastError = `桥在线、dshReady=false（上次修复在 ${Math.round((endpointRetryAfter - now()) / 1000)}s 后重试）`;
          return;
        }
        await repairEndpoint();
        return;
      }
      dshReady = undefined;
      // 人为停的桥不在线是**预期状态**，不该算故障：
      // 否则界面上先跳十几秒的「degraded / 连续失败 2 次」才变回 stopped。
      if (!wantsRunning()) {
        state = 'stopped';
        consecutiveFailures = 0;
        recoverAttempts = 0;
        lastError = undefined;
        return;
      }
      consecutiveFailures += 1;
      lastError = result.error;
      state = 'degraded';
      if (consecutiveFailures >= failuresBeforeRestart) await attemptRecovery(at);
      else if (!autoRecover) {
        // 还没到恢复阈值，但自动拉起本来就是关的 —— 让 hint 说清"不会拉"，
        // 而不是留一句光秃秃的 "fetch failed"（主人看了会以为它要动手）。
        lastError = '自动拉起已关闭（autoRecover=false），桥没在跑但这只看门狗不会拉它';
      }
    } finally {
      inFlight = false;
    }
  }

  const api = {
    start() {
      if (timer) return;
      void tick(); // 先探一次，别让状态在头 15 秒显示「未知」
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.(); // 巡检不该成为进程退出的阻碍
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      state = 'stopped';
    },
    async probeOnce() { await tick(); return api.snapshot(); },
    markStopped,
    clearStopped,
    wantsRunning,
    snapshot() {
      pruneWindow(now());
      return {
        state,
        autoRecover,
        consecutiveFailures,
        restartsInWindow: restartTimes.length,
        backoffMs,
        ...(dshReady === undefined ? {} : { dshReady }),
        ...(lastError ? { lastError } : {}),
        ...(lastProbeAt === undefined ? {} : { lastProbeAt }),
        ...(lastRestartAt === undefined ? {} : { lastRestartAt }),
      };
    },
  };
  return api;
}
