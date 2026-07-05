// RefreshWindow 执行器：所有抓取入口（手动/调度/登录后补抓）统一走 createRefreshWindow。
// 异步语义：创建即返回 Pending 资源；完成后档案落盘并增量并入索引。
// 进行中的 window 只存在于内存（runtime map），落盘的档案必然是终态——档案不可变性由此保证。

import { getSource } from './config'
import { defaultFetcher, type Fetcher } from './fetcher'
import { downloadAll } from './media'
import { normalizeItem, expandRawItems } from './normalize'
import { ingestWindow, getWindowResource, registerWindowResource } from './resources'
import { appendWindow, type Resource, type WindowFile } from './store'
import { rlog } from './logger'

export interface RefreshSpec {
  source: string
  count?: number
  trigger: 'manual' | 'scheduled' | 'post-login'
}

interface WatchEvent {
  type: 'log' | 'phase' | 'done'
  data: string
}

interface RunningWindow {
  resource: Resource
  events: WatchEvent[]
  subscribers: Set<(ev: WatchEvent) => void>
}

const running = new Map<string, RunningWindow>()

function emit(run: RunningWindow, ev: WatchEvent): void {
  run.events.push(ev)
  for (const fn of run.subscribers) fn(ev)
}

function uniqueName(source: string): string {
  let ts = Math.floor(Date.now() / 1000)
  let name = `${source}-${ts}`
  while (running.has(name) || getWindowResource(name)) {
    ts++
    name = `${source}-${ts}`
  }
  return name
}

export function createRefreshWindow(spec: RefreshSpec, fetcher: Fetcher = defaultFetcher()): Resource {
  const source = getSource(spec.source)
  if (!source) throw new Error(`unknown source: ${spec.source}`)
  const count = Math.min(Math.max(spec.count ?? 50, 1), 200)
  const name = uniqueName(spec.source)
  const now = new Date().toISOString()

  const resource: Resource = {
    apiVersion: 'radar/v1',
    kind: 'RefreshWindow',
    metadata: { name, creationTimestamp: now, labels: { source: source.name, account: source.account, platform: source.platform } },
    spec: { source: source.name, account: source.account, count, trigger: spec.trigger },
    status: { phase: 'Pending', startedAt: null, finishedAt: null, messageRefs: [], stats: null, error: null },
  }
  const run: RunningWindow = { resource, events: [], subscribers: new Set() }
  running.set(name, run)

  // 异步执行，不阻塞创建请求；推迟到下个事件循环，保证创建方拿到的是 Pending
  setTimeout(() => void executeWindow(run, source.platform, count, fetcher), 0)
  return resource
}

async function executeWindow(run: RunningWindow, platform: string, count: number, fetcher: Fetcher): Promise<void> {
  const resource = run.resource
  const status = resource.status as Record<string, unknown>
  const name = resource.metadata.name
  // 执行日志双写：watch SSE（实时）+ 日志文件（落盘可追溯）
  const log = (line: string) => {
    emit(run, { type: 'log', data: line })
    rlog(name, line)
  }

  rlog(name, `start (trigger=${(resource.spec as Record<string, unknown>).trigger}, count=${count})`)
  status.phase = 'Running'
  status.startedAt = new Date().toISOString()
  emit(run, { type: 'phase', data: 'Running' })

  let win: WindowFile
  try {
    const source = getSource(String((resource.spec as Record<string, unknown>).source))!
    const result = await fetcher.fetch(source, count, log)
    log(`fetched ${result.rawItems.length} raw items`)
    // 媒体本地化：先下载（manifest 登记），ingest 时回填本地地址
    await downloadAll(collectMediaUrls(platform, result.rawItems), log)
    status.phase = 'Succeeded'
    status.finishedAt = new Date().toISOString()
    win = { ...(resource as WindowFile), rawItems: result.rawItems }
  } catch (err) {
    status.phase = 'Failed'
    status.finishedAt = new Date().toISOString()
    status.error = err instanceof Error ? err.message : String(err)
    log(`failed: ${status.error}`)
    win = { ...(resource as WindowFile), rawItems: [] }
  }

  try {
    await appendWindow(win)
    if (status.phase === 'Succeeded') {
      const { newCount, dupCount } = await ingestWindow(win)
      // ingestWindow 已写入 stats；同步回运行中资源供 watch/查询
      const indexed = getWindowResource(name)
      if (indexed) {
        status.stats = (indexed.status as Record<string, unknown>).stats
        status.messageRefs = collectRefs(win)
        ;(indexed.status as Record<string, unknown>).messageRefs = status.messageRefs
      }
      log(`ingested: ${newCount} new, ${dupCount} duplicate`)
    } else {
      registerWindowResource(win)
    }
  } catch (err) {
    status.phase = 'Failed'
    status.error = `archive write failed: ${err instanceof Error ? err.message : String(err)}`
    log(String(status.error))
  }

  emit(run, { type: 'phase', data: String(status.phase) })
  emit(run, { type: 'done', data: JSON.stringify({ phase: status.phase, stats: status.stats ?? null, error: status.error ?? null }) })
  rlog(name, `done: ${status.phase}${status.error ? ` (${status.error})` : ''}`)
  running.delete(name)
}

function collectMediaUrls(platform: string, rawItems: unknown[]): string[] {
  const urls: string[] = []
  for (const raw of expandRawItems(platform, rawItems)) {
    const n = normalizeItem(platform, raw)
    if (!n) continue
    for (const m of n.message.spec.media) urls.push(m.originUrl)
    const avatar = n.message.spec.author?.avatar
    if (avatar && !avatar.startsWith('/')) urls.push(avatar)
    // 正文 HTML 内嵌图（知乎全文）一并本地化
    const content = n.message.spec.content
    if (content) {
      for (const m of content.matchAll(/<img[^>]+src="([^"]+)"/g)) {
        if (m[1].startsWith('http')) urls.push(m[1])
      }
    }
  }
  return urls
}

function collectRefs(win: WindowFile): string[] {
  // messageRefs 从 rawItems 派生：与 normalize 同源的命名规则
  const platform = String(win.metadata.labels?.platform ?? '')
  const refs: string[] = []
  for (const raw of win.rawItems) {
    const id = (raw as Record<string, unknown>)?.id
    if (id !== undefined && id !== null && id !== '') refs.push(`${platform}-${id}`)
  }
  return refs
}

/** 运行中的 window 资源（GET refreshwindows 时与落盘档案合并展示） */
export function runningWindowResources(): Resource[] {
  return [...running.values()].map(r => r.resource)
}

export function getRunningWindow(name: string): Resource | null {
  return running.get(name)?.resource ?? null
}

/** watch 订阅：先回放历史事件再实时推送；window 不在运行中返回 null */
export function watchWindow(name: string, onEvent: (ev: WatchEvent) => void): (() => void) | null {
  const run = running.get(name)
  if (!run) return null
  for (const ev of run.events) onEvent(ev)
  run.subscribers.add(onEvent)
  return () => run.subscribers.delete(onEvent)
}
