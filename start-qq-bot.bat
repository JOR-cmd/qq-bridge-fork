@echo off
chcp 65001 >nul
title QQ Bot
cd /d "%~dp0"

rem ── 看门狗：独立于桥、独立于 DSH，盯着桥 ──────────────────────────────
rem 为什么需要它 —— 桥是 start.bat 里 spawn 的独立进程，除了启动那一刻的 launch.mjs，
rem 这边对它一无所知。两种故障在界面上长得一模一样（QQ 不说话）：
rem   ① 进程死了             → 拉起
rem   ② 活着但 dshReady=false → DSH 换端口了，baseUrl 过期，**重启桥治不了**，
rem                               要先回写 config.json 再重启（2026-10-28 实测救回一次）
rem
rem ⚠ 2026-10-28：看门狗**默认不启动**（主人要求，暂时用不上）。
rem
rem 主开关是文件：state\watchdog-disabled 存在 = 连启动都不启动。
rem 三种状态的区别（别搞混）：
rem   · state\watchdog-disabled      → **不启动看门狗**（本次新增，主人现在的选择）
rem   · state\watchdog-no-autostart  → 启动看门狗，但它不自动拉起桥
rem   · 两个都没有                    → 启动看门狗，且它会在桥挂了时拉起桥
rem
rem 要恢复看门狗：删掉 state\watchdog-disabled 即可（文件存在就不启动）。
rem
rem 历史原因：看门狗会在桥被手动关掉时 spawn start.bat 拉起，而 start.bat 是 :loop
rem 守护 + cmd 的 start 会新开窗口，主人会看到一串命令提示符窗口自己冒出来。
if exist "state\watchdog-disabled" (
    echo [watchdog] 已停用（state\watchdog-disabled 存在），跳过
) else (
    if not exist "state\watchdog-no-autostart" (
        echo desired=no-autostart> "state\watchdog-no-autostart"
        echo created_by=start-qq-bot.bat>> "state\watchdog-no-autostart"
    )
    if not defined WATCHDOG_NO_AUTOSTART set WATCHDOG_NO_AUTOSTART=1
    rem 判断"已经在跑"用锁文件（本机 wmic 已被 Windows 11 移除，拿不到命令行）。
    if exist "state\watchdog.pid" (
        echo [watchdog] 锁文件存在，交给它自己判断
    ) else (
        start /min "" cmd /c "node watchdog.mjs"
    )
)

node launch.mjs
echo.
echo done - closing in 6s  (keep this window open to see logs)
"%SystemRoot%\System32\ping.exe" -n 7 127.0.0.1 >nul
