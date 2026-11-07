// 低频调度 controller（docs/design.md §8）：每轮对每个账号先 checkAuth，
// ok 的账号按源串行创建 scheduled RefreshWindow；logged_out 的跳过不空转。
// 开关/间隔是运行时可改的单例资源（GET/PATCH /api/v1/scheduler），落盘 SQLite ResourceStore；
// 环境变量只作为无配置文件时的初始默认（RADAR_SCHEDULER=off、RADAR_SCHEDULE_INTERVAL_MS）。
//
// 节奏带抖动：每轮的实际间隔是 intervalMs ±JITTER_RATIO 内的随机值，而不是严格等距。
// 采集走的是真实登录态浏览器，固定的 24/7 等距节奏是这套东西最像机器人的信号；
// 抖动只影响"什么时候抓"，不影响"抓什么"，也不改 intervalMs 本身的语义。

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
// 每轮间隔的随机浮动比例：30 分钟 → 24~36 分钟。
const JITTER_RATIO = 0.2

let spec: SchedulerSpec = { enabled: true, intervalMs: 30 * 60 * 1000 }
let timer: ReturnType<typeof setTimeout> | null = null
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

export function jitterDelayFor(intervalMs: number): number {
  const delta = intervalMs * JITTER_RATIO
  return Math.round(intervalMs - delta + Math.random() * 2 * delta)
}

function jitteredDelay(): number {
  return jitterDelayFor(spec.intervalMs)
}

// 单次定时器接力，而不是 setInterval：每轮结束后重新抽一次间隔。
function scheduleRound(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runRound().finally(() => {
      if (spec.enabled) scheduleRound(jitteredDelay())
      else nextRoundAt = null
    })
  }, delayMs)
  nextRoundAt = new Date(Date.now() + delayMs).toISOString()
}

function apply(bootstrap = false): void {
  if (timer) clearTimeout(timer)
  if (bootstrapTimer) clearTimeout(bootstrapTimer)
  timer = null
  bootstrapTimer = null
  nextRoundAt = null
  if (!spec.enabled) {
    rlog('scheduler', 'disabled')
    return
  }
  rlog('scheduler', `enabled, every ${Math.round(spec.intervalMs / 1000)}s ±${Math.round(JITTER_RATIO * 100)}%`)
  if (bootstrap) {
    // 启动后先补一轮，否则反复重启会永远等不满首个间隔；补的那轮之后才进抖动节奏
    const delay = Math.min(spec.intervalMs, 60_000)
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null
      void runRound().finally(() => {
        if (spec.enabled) scheduleRound(jitteredDelay())
      })
    }, delay)
    nextRoundAt = new Date(Date.now() + delay).toISOString()
    return
  }
  scheduleRound(jitteredDelay())
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
  if (timer) clearTimeout(timer)
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
  nextRoundAt = new Date(Date.now() + jitteredDelay()).toISOString()
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
