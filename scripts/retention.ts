// 保留策略的命令行入口：默认 dry-run，只统计不删。
//   bun scripts/retention.ts                    # 7 天，dry-run
//   bun scripts/retention.ts --apply            # 7 天，真删
//   bun scripts/retention.ts --days 3 --apply   # 3 天，真删
//   RADAR_DATA_DIR=/tmp/xx bun scripts/retention.ts --days 7
import { ensureDirs } from '../server/store'
import { runRetention, DEFAULT_RETENTION_DAYS } from '../server/retention'

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

const days = Number(argValue('--days') ?? DEFAULT_RETENTION_DAYS)
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number')
  process.exit(2)
}
const apply = process.argv.includes('--apply')

await ensureDirs()
const report = await runRetention({ retentionDays: days, dryRun: !apply })
console.log(JSON.stringify(report, null, 2))
