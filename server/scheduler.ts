// 低频调度 controller（docs/design.md §8）：每轮对每个账号先 checkAuth，
// ok 的账号按源串行创建 scheduled RefreshWindow；logged_out 的跳过不空转。
// 开关/间隔是运行时可改的单例资源（GET/PATCH /api/v1/scheduler），落盘 SQLite ResourceStore；
// 环境变量只作为无配置文件时的初始默认（RADAR_SCHEDULER=off、RADAR_SCHEDULE_INTERVAL_MS）。

import { ACCOUNTS, SOURCES } from './config'
import { checkAuth } from './auth'
import { createRefreshWindow, getRunningWindow } from './refresh'
import { sleep } from './cdp'
import { ensureDirs, type Resource, readSchedulerSpecFromStore, writeSchedulerSpecToStore } from './store'
import { SchedulerResource } from './resource-definitions'
import { rlog } from './logger'

interface SchedulerSpec {
  enabled: boolean
  intervalMs: number
}

const MIN_INTERVAL_MS = 60_000

let spec: SchedulerSpec = { enabled: true, intervalMs: 30 * 60 * 1000 }
let timer: ReturnType<typeof setInterval> | null = null
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null
let roundInProgress = false
let lastRoundAt: string | null = null
let nextRoundAt: string | null = null

function envDefaults(): SchedulerSpec {
  const interval = parseInt(process.env.RADAR_SCHEDULE_INTERVAL_MS ?? '', 10)
  return {
    enabled: process.env.RADAR_SCHEDULER !== 'off',
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : 30 * 60 * 1000,
  }
}

export async function initScheduler(): Promise<void> {
  const saved = await readSchedulerSpecFromStore()
  if (saved) {
    const def = envDefaults()
    spec = {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : def.enabled,
      intervalMs: typeof saved.intervalMs === 'number' && saved.intervalMs >= MIN_INTERVAL_MS ? saved.intervalMs : def.intervalMs,
    }
  } else {
    spec = envDefaults()
  }
  apply(true)
}

function apply(bootstrap = false): void {
  if (timer) clearInterval(timer)
  if (bootstrapTimer) clearTimeout(bootstrapTimer)
  timer = null
  bootstrapTimer = null
  nextRoundAt = null
  if (!spec.enabled) {
    rlog('scheduler', 'disabled')
    return
  }
  rlog('scheduler', `enabled, every ${Math.round(spec.intervalMs / 1000)}s`)
  timer = setInterval(() => void runRound(), spec.intervalMs)
  nextRoundAt = new Date(Date.now() + spec.intervalMs).toISOString()
  if (bootstrap) {
    // 启动后先补一轮，否则反复重启会永远等不满首个间隔
    const delay = Math.min(spec.intervalMs, 60_000)
    bootstrapTimer = setTimeout(() => void runRound(), delay)
    nextRoundAt = new Date(Date.now() + delay).toISOString()
  }
}

export function schedulerResource(): Resource {
  return {
    apiVersion: 'radar/v1',
    kind: SchedulerResource.kind,
    metadata: { name: 'default' },
    spec: { ...spec },
    status: { running: roundInProgress, lastRoundAt, nextRoundAt: spec.enabled ? nextRoundAt : null },
  }
}

export async function patchScheduler(patch: { enabled?: unknown; intervalMs?: unknown }): Promise<Resource> {
  if (typeof patch.enabled === 'boolean') spec.enabled = patch.enabled
  if (typeof patch.intervalMs === 'number') {
    if (patch.intervalMs < MIN_INTERVAL_MS) throw new Error(`intervalMs must be >= ${MIN_INTERVAL_MS}`)
    spec.intervalMs = Math.floor(patch.intervalMs)
  }
  await ensureDirs()
  await writeSchedulerSpecToStore({ ...spec })
  apply()
  rlog('scheduler', `patched: enabled=${spec.enabled} intervalMs=${spec.intervalMs}`)
  return schedulerResource()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  if (bootstrapTimer) clearTimeout(bootstrapTimer)
  timer = null
  bootstrapTimer = null
}

async function runRound(): Promise<void> {
  if (roundInProgress) {
    rlog('scheduler', 'previous round still running, skip')
    return
  }
  roundInProgress = true
  lastRoundAt = new Date().toISOString()
  nextRoundAt = new Date(Date.now() + spec.intervalMs).toISOString()
  try {
    for (const account of ACCOUNTS) {
      if (!spec.enabled) break // 轮中被关闭则尽快收手
      const auth = await checkAuth(account.name, s => rlog('scheduler', `${account.name}: ${s}`))
      if (auth.auth !== 'ok') {
        rlog('scheduler', `skip ${account.name}: ${auth.auth}`)
        continue
      }
      // 串行抓取，避免同时开太多 tab
      for (const source of SOURCES.filter(s => s.account === account.name)) {
        if (!spec.enabled) break
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
