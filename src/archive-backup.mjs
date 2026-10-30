// 冷存储备份：每日一份一致性快照（VACUUM INTO），轮转保留 7 份日份 + 12 份月首。
//
// 为什么不能直接复制 archive.db：库是 WAL 模式，直接 copy 会漏掉还没合并进主文件的写入，
// 备份出来可能是旧的甚至不一致。VACUUM INTO 由 SQLite 自己保证一致性，且顺带压缩。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const KEEP_DAILY = 7
const KEEP_MONTHLY = 12

function stamp(date, withDay) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return withDay ? `${y}${m}${d}` : `${y}${m}`
}

/**
 * 每天最多备份一次；同一天重复调用直接返回 null。
 * @param {string} dbPath
 * @param {string} backupDir
 * @param {Date} [now]
 * @returns {string|null} 新建的备份文件路径
 */
export function backupDaily(dbPath, backupDir, now = new Date()) {
  if (!fs.existsSync(dbPath)) return null
  fs.mkdirSync(backupDir, { recursive: true })

  const day = stamp(now, true)
  const daily = path.join(backupDir, `archive-${day}.db`)
  if (fs.existsSync(daily)) return null

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    // 路径里的单引号要转义，避免 SQL 注入式破坏
    db.exec(`VACUUM INTO '${daily.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }

  // 每月 1 号额外留一份，命名为 archive-YYYYMM.db
  if (now.getDate() === 1) {
    const monthly = path.join(backupDir, `archive-${stamp(now, false)}.db`)
    if (!fs.existsSync(monthly)) fs.copyFileSync(daily, monthly)
  }

  rotate(backupDir)
  return daily
}

function rotate(backupDir) {
  let names = []
  try {
    names = fs.readdirSync(backupDir).filter((n) => /^archive-\d{8}\.db$/.test(n)).sort()
  } catch {
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_DAILY))) {
    try { fs.rmSync(path.join(backupDir, name), { force: true }) } catch { /* ignore */ }
  }

  let months = []
  try {
    months = fs.readdirSync(backupDir).filter((n) => /^archive-\d{6}\.db$/.test(n)).sort()
  } catch {
    return
  }
  for (const name of months.slice(0, Math.max(0, months.length - KEEP_MONTHLY))) {
    try { fs.rmSync(path.join(backupDir, name), { force: true }) } catch { /* ignore */ }
  }
}

// 命令行：node src/archive-backup.mjs [--force]
if (process.argv[1] && process.argv[1].endsWith('archive-backup.mjs')) {
  const stateDir = path.resolve(import.meta.dirname, '..', 'state')
  const file = backupDaily(path.join(stateDir, 'archive.db'), path.join(stateDir, 'backup'))
  console.log(file ? `已备份: ${file}` : '今天已经备份过（或数据库不存在）')
}
