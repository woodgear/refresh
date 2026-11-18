// 保留策略：refresh 是信息流，不是收藏夹。超过保留期的抓取档案、
// 不再出现的 message、无人引用的媒体和 overlay 一并清掉，并压掉旧变更事件。
//
// 判据（都按「抓取 / 最后出现时间」，不按内容发布时间）：
//   - refresh-window：created_at 超龄 → 连同 items 一起删
//   - feed-page / aggregate-feed-page / feed-source-page：created_at 超龄 → 删
//   - message：annotation radar/lastSeenWindow 指向的 window 已不在保留期。
//     不用 updated_at：那反映的是「用户点了已读」，相对抓取时间是噪声。
//   - author：没有任何保留中的 message 引用
//   - overlay-entry：它 overlay-for 的目标已经不在保留集合里
//   - media-object：文件不被任何保留中的 message spec 引用
//
// 故意不动 followee-window / followee-window-item：关注列表的 Followee 资源是从这些
// 窗口重放出来的（buildFolloweeIndex），删了窗口重启后关注列表会空掉。
//
// 删除走 litectl_delete_many（整批一个事务，18 万行 40 秒）；refresh 的 kind 声明了
// events: none，所以删除不再产生事件，末尾的 compact 只是为了清掉历史遗留。

import { rm } from 'fs/promises'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import { MEDIA_DIR, MEDIA_VARIANTS_DIR } from './store'
import { resourceDatabase } from './resource-store'
import {
  AggregateFeedPageResource,
  AuthorResource,
  FeedPageResource,
  FeedSourcePageResource,
  MediaObjectResource,
  MessageResource,
  OverlayEntryResource,
  RefreshWindowItemResource,
  RefreshWindowResource,
  type ResourceDefinition,
} from './resource-definitions'
import { rlog } from './logger'

export const DEFAULT_RETENTION_DAYS = 7

export interface RetentionOptions {
  retentionDays?: number
  /** 只统计不删除（默认） */
  dryRun?: boolean
  /** 覆盖当前时间（测试用） */
  now?: number
}

export interface RetentionReport {
  retentionDays: number
  cutoff: string
  dryRun: boolean
  windows: number
  windowItems: number
  feedPages: number
  messages: number
  authors: number
  overlays: number
  mediaObjects: number
  mediaBytes: number
  compactedEvents: number
  durationMs: number
}

const API_VERSION = 'radar/v1'

function namesOf(db: Database, sql: string, params: (string | number)[] = []): string[] {
  return db.query<{ name: string }, (string | number)[]>(sql).all(...params).map(row => row.name)
}

function placeholders(values: unknown[]): string {
  return values.length === 0 ? 'NULL' : values.map(() => '?').join(',')
}

/** 一条 message 引用到的本地媒体文件名（media[].url / author.avatar / content 内联图） */
export function referencedMediaFiles(specJson: string): string[] {
  const out: string[] = []
  const push = (value: unknown) => {
    if (typeof value !== 'string') return
    const match = value.match(/\/api\/v1\/media\/([a-f0-9]{64}\.[a-z0-9]+)/)
    if (match) out.push(match[1]!)
  }
  let spec: Record<string, unknown>
  try {
    spec = JSON.parse(specJson) as Record<string, unknown>
  } catch {
    return out
  }
  const media = spec.media
  if (Array.isArray(media)) {
    for (const item of media) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      push(record.url)
    }
  }
  const author = spec.author
  if (author && typeof author === 'object') push((author as Record<string, unknown>).avatar)
  const content = spec.content
  if (typeof content === 'string' && content.includes('/api/v1/media/')) {
    for (const match of content.matchAll(/\/api\/v1\/media\/([a-f0-9]{64}\.[a-z0-9]+)/g)) out.push(match[1]!)
  }
  return out
}

interface MediaCandidate {
  file: string
  bytes: number
}

function collectMedia(db: Database): MediaCandidate[] {
  const candidates = db
    .query<{ name: string; spec_json: string }, []>(
      `SELECT name, spec_json FROM resources
        WHERE api_version = '${API_VERSION}' AND kind = 'media-object'`,
    )
    .all()
    .map(row => {
      let bytes = 0
      try {
        const spec = JSON.parse(row.spec_json) as Record<string, unknown>
        if (typeof spec.bytes === 'number') bytes = spec.bytes
      } catch {
        bytes = 0
      }
      return { file: row.name, bytes }
    })

  return candidates
}

export async function runRetention(options: RetentionOptions = {}): Promise<RetentionReport> {
  const startedAt = Date.now()
  const db = resourceDatabase()
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
  const dryRun = options.dryRun ?? true
  const now = options.now ?? Date.now()
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000

  const expiredWindows = namesOf(
    db,
    `SELECT name FROM resources WHERE api_version = ? AND kind = 'refresh-window' AND created_at < ?`,
    [API_VERSION, cutoff],
  )
  const windowItems = namesOf(
    db,
    `SELECT r.name FROM resources r
       JOIN labels l ON l.resource_id = r.id AND l.key = 'window'
      WHERE r.api_version = ? AND r.kind = 'refresh-window-item' AND l.value IN (${placeholders(expiredWindows)})`,
    [API_VERSION, ...expiredWindows],
  )
  // 三种 page 的 name 空间不同，必须按 kind 分开查再分别删
  const expiredPagesByKind = {
    feed: namesOf(db, `SELECT name FROM resources WHERE api_version = ? AND kind = 'feed-page' AND created_at < ?`, [API_VERSION, cutoff]),
    aggregate: namesOf(db, `SELECT name FROM resources WHERE api_version = ? AND kind = 'aggregate-feed-page' AND created_at < ?`, [API_VERSION, cutoff]),
    source: namesOf(db, `SELECT name FROM resources WHERE api_version = ? AND kind = 'feed-source-page' AND created_at < ?`, [API_VERSION, cutoff]),
  }
  const expiredPages = expiredPagesByKind.feed.length + expiredPagesByKind.aggregate.length + expiredPagesByKind.source.length

  // message 的保留判据用 annotation radar/lastSeenWindow：它记录「最后一次出现在哪批推送里」。
  // 不能用 updated_at —— 只要 window-item 还在，下次启动重放 raw 就会把删掉的 message 重建出来；
  // 而 lastSeenWindow 指向的 window 一旦删掉，这条 message 就不可能再从保留数据里重放出来。
  const keptWindowSet = new Set(
    namesOf(db, `SELECT name FROM resources WHERE api_version = ? AND kind = 'refresh-window' AND created_at >= ?`, [API_VERSION, cutoff]),
  )
  const messageRows = db
    .query<{ name: string; last_seen: string | null; spec_json: string }, [string]>(
      `SELECT name,
              json_extract(annotations, '$."radar/lastSeenWindow"') AS last_seen,
              spec_json
         FROM resources
        WHERE api_version = ? AND kind = 'message'`,
    )
    .all(API_VERSION)
  const keptMessages = messageRows.filter(row => row.last_seen !== null && keptWindowSet.has(row.last_seen))
  const keptMessageNames = new Set(keptMessages.map(row => row.name))
  const expiredMessages = messageRows.filter(row => !keptMessageNames.has(row.name)).map(row => row.name)

  // author 跟着 message 走：没有保留中的 message 引用它就删。
  // spec.author.ref 就是 Author 资源的 name（如 bilibili-2132180406），不带固定前缀。
  const keptAuthorRefs = new Set<string>()
  for (const row of keptMessages) {
    let spec: Record<string, unknown>
    try {
      spec = JSON.parse(row.spec_json) as Record<string, unknown>
    } catch {
      continue
    }
    const author = spec.author
    if (!author || typeof author !== 'object') continue
    const ref = (author as Record<string, unknown>).ref
    if (typeof ref === 'string' && ref) keptAuthorRefs.add(ref)
  }
  const expiredAuthors = namesOf(
    db,
    `SELECT name FROM resources WHERE api_version = ? AND kind = 'author'`,
    [API_VERSION],
  ).filter(name => !keptAuthorRefs.has(name))

  const keptMessageSet = keptMessageNames
  const keptAuthorSet = keptAuthorRefs
  const orphanOverlays = db
    .query<{ name: string; target_kind: string; target_name: string }, [string]>(
      `SELECT o.name AS name, t.kind AS target_kind, t.name AS target_name
         FROM resources o
         JOIN resource_links link ON link.from_id = o.id AND link.relation = 'overlay-for'
         JOIN resources t ON t.id = link.to_id
        WHERE o.api_version = ? AND o.kind = 'overlay-entry'`,
    )
    .all(API_VERSION)
    .filter(row => (row.target_kind === 'message'
      ? !keptMessageSet.has(row.target_name)
      : row.target_kind === 'author'
        ? !keptAuthorSet.has(row.target_name)
        : false))
    .map(row => row.name)

  const candidates = collectMedia(db)
  const visibleMediaFiles = new Set<string>()
  for (const row of keptMessages) {
    for (const file of referencedMediaFiles(row.spec_json)) visibleMediaFiles.add(file)
  }
  const orphanMedia = candidates.filter(item => !visibleMediaFiles.has(item.file))
  const mediaBytes = orphanMedia.reduce((sum, item) => sum + item.bytes, 0)

  const report: RetentionReport = {
    retentionDays,
    cutoff: new Date(cutoff).toISOString(),
    dryRun,
    windows: expiredWindows.length,
    windowItems: windowItems.length,
    feedPages: expiredPages,
    messages: expiredMessages.length,
    authors: expiredAuthors.length,
    overlays: orphanOverlays.length,
    mediaObjects: orphanMedia.length,
    mediaBytes,
    compactedEvents: 0,
    durationMs: 0,
  }
  report.durationMs = Date.now() - startedAt

  if (dryRun) {
    rlog('retention', `dry-run ${formatReport(report)}`)
    return report
  }

  // 先删明细再删汇总：中途失败也不会留下指向不存在目标的链接。
  deleteBatch(db, RefreshWindowItemResource, windowItems)
  deleteBatch(db, FeedPageResource, expiredPagesByKind.feed)
  deleteBatch(db, AggregateFeedPageResource, expiredPagesByKind.aggregate)
  deleteBatch(db, FeedSourcePageResource, expiredPagesByKind.source)
  deleteBatch(db, OverlayEntryResource, orphanOverlays)
  deleteBatch(db, MessageResource, expiredMessages)
  deleteBatch(db, AuthorResource, expiredAuthors)
  deleteBatch(db, RefreshWindowResource, expiredWindows)
  deleteBatch(db, MediaObjectResource, orphanMedia.map(item => item.file))
  await removeMediaFiles(orphanMedia)

  report.compactedEvents = compactEvents(db, cutoff)
  report.durationMs = Date.now() - startedAt
  rlog('retention', `applied ${formatReport(report)}`)
  return report
}

function formatReport(report: RetentionReport): string {
  return [
    `${report.retentionDays}d cutoff=${report.cutoff}`,
    `windows=${report.windows}/${report.windowItems}items`,
    `pages=${report.feedPages}`,
    `messages=${report.messages}`,
    `authors=${report.authors}`,
    `overlays=${report.overlays}`,
    `media=${report.mediaObjects} (${(report.mediaBytes / 1048576).toFixed(1)} MiB)`,
    report.compactedEvents ? `compactedEvents=${report.compactedEvents}` : '',
    `${report.durationMs}ms`,
  ].filter(Boolean).join(' ')
}

/**
 * 批量删除：整批一个事务（litectl_delete_many）。
 * 逐条 litectl_delete 是 3.2ms/行（每条一次 fsync），18 万行要 12 分钟；
 * 批量 1000 行 5ms，同样的量 40 秒。
 */
function deleteBatch(db: Database, definition: ResourceDefinition, names: string[]): number {
  if (names.length === 0) return 0
  const statement = db.query<{ result: string }, [string, string, string]>(
    'SELECT litectl_delete_many(?, ?, ?, 1) AS result',
  )
  let deleted = 0
  for (let start = 0; start < names.length; start += 5000) {
    const chunk = names.slice(start, start + 5000)
    const row = statement.get(API_VERSION, definition.storageKind, JSON.stringify(chunk))
    if (!row) continue
    deleted += (JSON.parse(row.result) as { deleted: number }).deleted
  }
  return deleted
}

async function removeMediaFiles(items: MediaCandidate[]): Promise<void> {
  for (const item of items) {
    const hash = item.file.split('.')[0]
    await rm(join(MEDIA_DIR, item.file), { force: true })
    if (hash) await rm(join(MEDIA_VARIANTS_DIR, hash), { recursive: true, force: true })
  }
}

/** 只压 cutoff 之前的事件，最近的事件留着给 watch / 排错用。 */
function compactEvents(db: Database, cutoff: number): number {
  try {
    const row = db
      .query<{ rv: number | null }, [number]>(
        `SELECT max(rv) AS rv FROM events WHERE created_at < ?`,
      )
      .get(cutoff)
    if (!row?.rv) return 0
    const deleted = db
      .query<{ deleted: number }, [number]>('SELECT litectl_compact_events(?) AS deleted')
      .get(row.rv)
    return deleted?.deleted ?? 0
  } catch (error) {
    rlog('retention', `compact events skipped: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}
