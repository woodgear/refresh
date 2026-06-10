// 低频调度 controller（docs/design.md §8）：每 30 分钟对每个账号先 checkAuth，
// ok 的账号按源串行创建 scheduled RefreshWindow；logged_out 的跳过不空转（状态已写入 Account.status）。
// RADAR_SCHEDULER=off 关闭；RADAR_SCHEDULE_INTERVAL_MS 覆盖间隔（verify 用短间隔观察）。

import { ACCOUNTS, SOURCES } from './config'
import { checkAuth } from './auth'
import { createRefreshWindow, getRunningWindow } from './refresh'
import { sleep } from './cdp'
import { rlog } from './logger'

const INTERVAL_MS = parseInt(process.env.RADAR_SCHEDULE_INTERVAL_MS ?? '', 10) || 30 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let roundInProgress = false

export function startScheduler(): void {
  if (process.env.RADAR_SCHEDULER === 'off') {
    rlog('scheduler', 'disabled (RADAR_SCHEDULER=off)')
    return
  }
  rlog('scheduler', `every ${Math.round(INTERVAL_MS / 1000)}s`)
  timer = setInterval(() => void runRound(), INTERVAL_MS)
  // 启动后先补一轮（稍等让登录态预热先行），否则反复重启会导致永远等不满首个间隔
  setTimeout(() => void runRound(), Math.min(INTERVAL_MS, 60_000))
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function runRound(): Promise<void> {
  if (roundInProgress) {
    rlog('scheduler', 'previous round still running, skip')
    return
  }
  roundInProgress = true
  try {
    for (const account of ACCOUNTS) {
      const auth = await checkAuth(account.name, s => rlog('scheduler', `${account.name}: ${s}`))
      if (auth.auth !== 'ok') {
        rlog('scheduler', `skip ${account.name}: ${auth.auth}`)
        continue
      }
      // 串行抓取，避免同时开太多 tab
      for (const source of SOURCES.filter(s => s.account === account.name)) {
        try {
          const win = createRefreshWindow({ source: source.name, trigger: 'scheduled' })
          await waitWindowDone(win.metadata.name)
        } catch (err) {
          rlog('scheduler', `${source.name} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
  } finally {
    roundInProgress = false
  }
}

async function waitWindowDone(name: string, timeoutMs = 5 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!getRunningWindow(name)) return
    await sleep(1000)
  }
}
