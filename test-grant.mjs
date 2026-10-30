// 回归：授权闸门的行为（不联网、不写入任何真实数据）
import fs from 'node:fs'
import {
  WRITABLE_KINDS, emptyGrant, loadGrant, checkWriteAllowed, recordWrite, writeStatus,
} from './src/bili-write-grant.mjs'

const DIR = '<WORK_ROOT>/_granttest'
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
const grantPath = `${DIR}/grant.json`
const usagePath = `${DIR}/usage.json`

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}  ${detail}`) }
}

console.log('\n[1] 枚举里没有评论')
check('WRITABLE_KINDS 不含 comment', !WRITABLE_KINDS.includes('comment'))
check('WRITABLE_KINDS 不含 reply', !WRITABLE_KINDS.includes('reply'))
check('WRITABLE_KINDS 不含 dm', !WRITABLE_KINDS.includes('dm'))
check('只有 likes/favorites/coins', JSON.stringify(WRITABLE_KINDS) === '["likes","favorites","coins"]')

console.log('\n[2] 没有授权文件时')
const noFile = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', config: { enableLikeWrites: true }, grantPath: `${DIR}/nope.json`, usagePath })
check('拒绝（GRANT_FILE_MISSING）', !noFile.allowed && noFile.code === 'GRANT_FILE_MISSING', noFile.code)

console.log('\n[3] 评论类型直接被拒（即使其他条件全满足）')
fs.writeFileSync(grantPath, JSON.stringify({ ...emptyGrant('123456'), enabled: true, handoverConfirmed: true }))
const comment = checkWriteAllowed({ kind: 'comment', bvid: 'BV1eGaz6JEJa', config: { enableCommentWrites: true }, grantPath, usagePath })
check('comment 被拒（WRITE_KIND_DENIED）', !comment.allowed && comment.code === 'WRITE_KIND_DENIED', comment.code)

console.log('\n[4] 授权文件校验')
const badCases = [
  ['enabled=false', { ...emptyGrant('123'), handoverConfirmed: true }],
  ['handoverConfirmed=false', { ...emptyGrant('123'), enabled: true }],
  ['已过期', { ...emptyGrant('123'), enabled: true, handoverConfirmed: true, expiresAt: '2020-01-01T00:00:00Z' }],
  ['videos 空且 allVideos=false', { ...emptyGrant('123'), enabled: true, handoverConfirmed: true, expiresAt: '2030-01-01T00:00:00Z' }],
  ['videos 含非 BV', { ...emptyGrant('123'), enabled: true, handoverConfirmed: true, expiresAt: '2030-01-01T00:00:00Z', videos: ['oops'] }],
  ['maxWrites 越界', { ...emptyGrant('123'), enabled: true, handoverConfirmed: true, expiresAt: '2030-01-01T00:00:00Z', videos: ['BV1eGaz6JEJa'], likes: { enabled: true, maxWrites: 999 } }],
]
for (const [label, g] of badCases) {
  fs.writeFileSync(grantPath, JSON.stringify(g))
  const r = loadGrant(grantPath)
  check(`${label.padEnd(28)} 被拒`, !r.ok, r.code)
}

console.log('\n[5] 合法授权 + 全部条件满足')
const goodGrant = {
  ...emptyGrant('123456'),
  enabled: true,
  handoverConfirmed: true,
  expiresAt: '2030-01-01T00:00:00Z',
  videos: ['BV1eGaz6JEJa'],
  likes: { enabled: true, maxWrites: 2 },
  coins: { enabled: true, maxWrites: 2, maxCoins: 5, maxPerVideo: 2 },
}
fs.writeFileSync(grantPath, JSON.stringify(goodGrant))
fs.rmSync(usagePath, { force: true })

const ok1 = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', config: { enableLikeWrites: true }, grantPath, usagePath })
check('放行', ok1.allowed, ok1.code + ' ' + (ok1.reason ?? ''))
check('plan 里写明没有写凭据', /absent/.test(ok1.plan?.credentialForWrite ?? ''), ok1.plan?.credentialForWrite)

console.log('\n[6] 次数上限与间隔')
recordWrite({ kind: 'likes', grant: goodGrant, usagePath, now: Date.now() })
const gap = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', config: { enableLikeWrites: true }, grantPath, usagePath })
check('60 秒内被限流', !gap.allowed && gap.code === 'WRITE_RATE_LIMIT', gap.code)
const later = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', config: { enableLikeWrites: true }, grantPath, usagePath, now: Date.now() + 61000 })
check('61 秒后放行', later.allowed, later.code)
recordWrite({ kind: 'likes', grant: goodGrant, usagePath, now: Date.now() + 61000 })
const over = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', config: { enableLikeWrites: true }, grantPath, usagePath, now: Date.now() + 130000 })
check('用满 2 次后被拒', !over.allowed && over.code === 'WRITE_QUOTA_EXCEEDED', over.code)

console.log('\n[7] 视频白名单与未知参数')
const wrongVideo = checkWriteAllowed({ kind: 'coins', bvid: 'BV0000000000', config: { enableCoinWrites: true }, grantPath, usagePath, now: Date.now() + 300000 })
check('不在名单的视频被拒', !wrongVideo.allowed && wrongVideo.code === 'WRITE_TARGET_DENIED', wrongVideo.code)
const extraArg = checkWriteAllowed({ kind: 'likes', bvid: 'BV1eGaz6JEJa', args: { bvid: 'BV1eGaz6JEJa', comment: 'hi' }, config: { enableLikeWrites: true }, grantPath, usagePath, now: Date.now() + 300000 })
check('多传参数被拒', !extraArg.allowed && extraArg.code === 'UNKNOWN_PARAMETER', extraArg.code)

console.log('\n[8] 状态摘要')
const st = writeStatus({ grantPath, usagePath })
check('forbiddenByDesign 含 comment', st.forbiddenByDesign.includes('comment'))
check('摘要里有 usage', Object.keys(st.usage).length > 0)

fs.rmSync(DIR, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
