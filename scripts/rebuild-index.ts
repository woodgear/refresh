// 用当前 normalizer 重算历史 message 的 spec（读路径直查后，normalize 只在写入时执行，
// 改 normalizer 不会自动影响老数据）。默认 dry-run。
//
//   bun scripts/rebuild-index.ts            # 只统计有多少条会被重算
//   bun scripts/rebuild-index.ts --apply    # 真写回
//
// 只更新已存在的 message（不新建、不删除），保留 created_at / lastSeenWindow / overlay，
// 所以已读状态和保留策略的判据都不受影响。

import { ensureDirs, listWindowNames, readWindowFile } from '../server/store'
import { rebuildMessages } from '../server/resources'

const apply = process.argv.includes('--apply')
await ensureDirs()
const report = await rebuildMessages({ dryRun: !apply })
console.log(JSON.stringify(report, null, 2))
