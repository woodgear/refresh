// 资源读写的业务层。
//
// 读：所有查询直接下推到 SQLite（见 queries.ts），启动不再把整库重放进内存。
// 写：抓取到的 window 逐条 normalize 后写入资源库；重复内容在这里合并派生字段和 sources。
//
// normalize 语义变了：以前每次启动重放全部 window，所以改了 normalizer 后重启即对历史数据
// 生效。现在 normalize 只在写入时执行，改 normalizer 想重算历史数据要显式跑
// `scripts/rebuild-index.ts`（会用当前 normalizer 重放 window 并覆盖 message/author）。

import { ACCOUNTS, getSource } from './config'
import { normalizeItem, expandRawItems } from './normalize'
import { localMediaUrl, mediaPresentationForUrl } from './media'
import {
  putStoredResource,
  type OverlayEntry,
  type OverlayKind,
  type Resource,
  type WindowFile,
} from './store'
import { resourceDatabase } from './resource-store'
import {
  getRefreshResource,
  listRefreshResources,
  listRefreshResourcesByNames,
} from './litectl-resource-facade'
import {
  AccountStatusResource,
  AuthorResource,
  MessageResource,
  RefreshWindowResource,
  type ResourceDefinition,
} from './resource-definitions'
import {
  selectAuthorNames,
  selectMessageNames,
  selectMessages,
  selectOverlay,
  selectUnreadSources,
  selectWindows,
  type WindowRow,
} from './queries'

export interface MessageStatus extends Record<string, unknown> {
  hydrated: boolean
}

export interface AuthorStatus extends Record<string, unknown> {
  messageCount: number
  lastSeenAt: string | null
}

function database() {
  return resourceDatabase()
}

/** 可重算派生字段：重复出现时允许更新（docs/design.md §2 可变性策略） */
function mergeDerivedSpec(oldSpec: Record<string, unknown>, newSpec: Record<string, unknown>): void {
  if (newSpec.stats) oldSpec.stats = newSpec.stats
  if (newSpec.durationSec !== undefined) oldSpec.durationSec = newSpec.durationSec
}

function attachMediaPresentation(media: { url: string | null; width?: number; height?: number }): void {
  if (!media.url) return
  const presentation = mediaPresentationForUrl(media.url, media)
  if (presentation) Object.assign(media, { presentation })
}

function localizeAvatar(author: { avatar?: string | null } | undefined): void {
  if (!author?.avatar) return
  const localAvatar = localMediaUrl(author.avatar)
  if (!localAvatar) return
  author.avatar = localAvatar
  const presentation = mediaPresentationForUrl(localAvatar)
  if (presentation) Object.assign(author, { avatarPresentation: presentation })
}

// ---------- 写入 ----------

export async function ingestWindow(win: WindowFile, opts: { persist?: boolean } = {}): Promise<{ newCount: number; dupCount: number }> {
  const persist = opts.persist ?? true
  const source = getSource(String((win.spec as Record<string, unknown>).source))
  const windowName = win.metadata.name
  const fetchedAt = win.metadata.creationTimestamp ?? null
  const platform = source?.platform ?? String(windowName.split('-')[0])
  const db = database()
  let newCount = 0
  let dupCount = 0
  const changed = new Map<string, Resource>()

  for (const raw of expandRawItems(platform, win.rawItems ?? [])) {
    const normalized = normalizeItem(platform, raw)
    if (!normalized) continue

    const { message, author } = normalized
    const existing = getRefreshResource(db, MessageResource, message.name) as Resource<Record<string, unknown>, MessageStatus> | null
    if (existing) {
      dupCount++
      mergeDerivedSpec(existing.spec, message.spec as unknown as Record<string, unknown>)
      const annotations = (existing.metadata.annotations = existing.metadata.annotations ?? {})
      annotations['radar/lastSeenWindow'] = windowName
      // 同一条内容可能被多个源推到（如关注的人的推文同时出现在推荐流）：归属是集合
      if (source) {
        const cur = (annotations['radar/sources'] ?? existing.metadata.labels?.source ?? '')
          .split(',')
          .filter(Boolean)
        if (!cur.includes(source.name)) {
          cur.push(source.name)
          annotations['radar/sources'] = cur.join(',')
        }
      }
      changed.set(`Message/${existing.metadata.name}`, existing)
    } else {
      newCount++
      // 媒体/头像回填：已本地化的换成 /api/v1/media/<hash>，否则保留外链
      for (const m of message.spec.media) {
        m.url = m.url ?? localMediaUrl(m.originUrl)
        attachMediaPresentation(m)
      }
      // 不同尺寸参数的同一张图本地化后哈希相同，按最终地址去重
      const seenMedia = new Set<string>()
      message.spec.media = message.spec.media.filter(m => {
        const key = m.url ?? m.originUrl
        if (seenMedia.has(key)) return false
        seenMedia.add(key)
        return true
      })
      localizeAvatar(message.spec.author)
      // 正文 HTML 里的图也换成本地化地址（RSS/UI 都不再依赖图床防盗链）
      if (message.spec.content) {
        message.spec.content = message.spec.content.replace(/(<img[^>]+src=")([^"]+)(")/g, (whole, pre, src, post) => {
          const local = localMediaUrl(src)
          return local ? `${pre}${local}${post}` : whole
        })
      }
      changed.set(`Message/${message.name}`, {
        apiVersion: 'radar/v1',
        kind: MessageResource.kind,
        metadata: {
          name: message.name,
          labels: {
            platform,
            ...(source ? { source: source.name, account: source.account } : {}),
            ...(message.spec.author?.ref ? { author: message.spec.author.ref } : {}),
          },
          annotations: {
            'radar/firstSeenWindow': windowName,
            'radar/lastSeenWindow': windowName,
            ...(source ? { 'radar/sources': source.name } : {}),
          },
          creationTimestamp: message.creationTimestamp ?? fetchedAt ?? undefined,
        },
        spec: message.spec as unknown as Record<string, unknown>,
        status: { hydrated: message.spec.content != null },
      } as Resource)
    }

    if (author) {
      // 同一次 ingest 里同一个 author 会重复出现：先看本次已累积的版本，再回库读
      const pendingAuthor = changed.get(`Author/${author.name}`) as Resource<Record<string, unknown>, AuthorStatus> | undefined
      const existingAuthor = pendingAuthor
        ?? getRefreshResource(db, AuthorResource, author.name) as Resource<Record<string, unknown>, AuthorStatus> | null
      if (existingAuthor) {
        existingAuthor.status.messageCount = (existingAuthor.status.messageCount ?? 0) + (existing ? 0 : 1)
        existingAuthor.status.lastSeenAt = fetchedAt
        // 快照字段允许跟进最新（作者改名/换头像）
        Object.assign(existingAuthor.spec, stripUndefined(author.spec))
        changed.set(`Author/${existingAuthor.metadata.name}`, existingAuthor)
      } else {
        const spec = stripUndefined(author.spec)
        localizeAvatar(spec)
        changed.set(`Author/${author.name}`, {
          apiVersion: 'radar/v1',
          kind: AuthorResource.kind,
          metadata: { name: author.name, labels: { platform }, annotations: {} },
          spec,
          status: { messageCount: 1, lastSeenAt: fetchedAt },
        } as Resource)
      }
    }
  }

  if (persist) {
    changed.set(`RefreshWindow/${win.metadata.name}`, buildWindowResource(win, { newCount, dupCount }))
    for (const resource of changed.values()) await putStoredResource(resource)
  }
  return { newCount, dupCount }
}

function buildWindowResource(win: WindowFile, counts: { newCount: number; dupCount: number }): Resource {
  const { rawItems: _rawItems, ...resource } = win
  const status = resource.status as Record<string, unknown>
  const stats = (status.stats ?? {}) as Record<string, unknown>
  status.stats = { ...stats, new: counts.newCount, duplicate: counts.dupCount, fetched: counts.newCount + counts.dupCount }
  return resource as Resource
}

/** 归档已由 ingestWindow 写入；保留这个入口给「只登记不上报」的调用点，不再维护内存索引。 */
export function registerWindowResource(_win: WindowFile, _counts?: { newCount: number; dupCount: number }): void {}

// ---------- 查询（全部走 SQL） ----------

/** 解析 "k=v,k2=v2" selector；空/undefined 返回 null（不过滤） */
export function parseSelector(selector: string | undefined): Record<string, string> | null {
  if (!selector) return null
  const out: Record<string, string> = {}
  for (const pair of selector.split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) throw new Error(`invalid selector segment: ${pair}`)
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

export interface ListMessagesOpts {
  labelSelector?: string
  authorSelector?: string
  /** 指定名称列表（保序），window 浏览用 */
  names?: string[]
  limit?: number
  sort?: 'time' | 'unread-first'
  unreadOnly?: boolean
}

function overlayEntries(kind: OverlayKind, names: string[]): Record<string, OverlayEntry> {
  return selectOverlay(kind, names)
}

function applyEntry(resource: Resource, entry: OverlayEntry | undefined): Resource {
  if (!entry) return resource
  return {
    ...resource,
    metadata: {
      ...resource.metadata,
      ...(entry.labels ? { labels: { ...(resource.metadata.labels ?? {}), ...entry.labels } } : {}),
      ...(entry.annotations ? { annotations: { ...(resource.metadata.annotations ?? {}), ...entry.annotations } } : {}),
    },
    status: { ...(resource.status as Record<string, unknown>), ...(entry.status ?? {}) } as Resource['status'],
  }
}

export async function listMessages(opts: ListMessagesOpts) {
  const selector = parseSelector(opts.labelSelector)
  const source = selector?.source ?? null
  const restSelector = selector
    ? Object.fromEntries(Object.entries(selector).filter(([key]) => key !== 'source'))
    : null

  let authorNames: string[] | null = null
  if (opts.authorSelector) {
    authorNames = selectAuthorNames(parseSelector(opts.authorSelector), null)
    if (authorNames.length === 0) return []
  }

  // names 模式：window 浏览 / feed 翻页，按给定顺序取
  if (opts.names) {
    const wanted = opts.limit && opts.limit > 0 ? opts.names.slice(0, opts.limit) : opts.names
    const rows = selectMessageNames(wanted)
    const byName = new Map(rows.map(row => [row.name, row]))
    const ordered = wanted
      .map(name => byName.get(name)?.name)
      .filter((name): name is string => !!name)
    if (ordered.length === 0) return []
    const resources = new Map(
      listRefreshResourcesByNames(database(), MessageResource, ordered).map(r => [r.metadata.name, r]),
    )
    const overlay = overlayEntries('messages', ordered)
    return ordered
      .map(name => resources.get(name))
      .filter((resource): resource is Resource => !!resource)
      .map(resource => applyEntry(resource, overlay[resource.metadata.name]))
  }

  const rows = selectMessages({
    labelSelector: restSelector,
    source,
    authorNames,
    unreadOnly: opts.unreadOnly,
    sort: opts.sort,
    limit: opts.limit,
  })
  const names = rows.map(row => row.name)
  if (names.length === 0) return []
  const resources = new Map(
    listRefreshResourcesByNames(database(), MessageResource, names).map(r => [r.metadata.name, r]),
  )
  const overlay = overlayEntries('messages', names)
  return names
    .map(name => resources.get(name))
    .filter((resource): resource is Resource => !!resource)
    .map(resource => applyEntry(resource, overlay[resource.metadata.name]))
}

/** 各源未读数（按多源归属计；total 为去重后的全局未读数） */
export async function unreadCounts(): Promise<{ total: number; sources: Record<string, number> }> {
  const sources: Record<string, number> = {}
  let total = 0
  for (const raw of selectUnreadSources()) {
    total++
    for (const name of raw.split(',').filter(Boolean)) sources[name] = (sources[name] ?? 0) + 1
  }
  return { total, sources }
}

export async function getMessage(name: string) {
  const resource = getRefreshResource(database(), MessageResource, name)
  if (!resource) return null
  return applyEntry(resource, overlayEntries('messages', [name])[name])
}

/** 全部 message（只给「有多少条新内容」这类低频统计用，不要用于分页）。 */
export function messageResources(): Resource[] {
  return listRefreshResources(database(), MessageResource)
}

export async function listAuthors(opts: { labelSelector?: string; limit?: number }) {
  const names = selectAuthorNames(parseSelector(opts.labelSelector), opts.limit ?? null)
  if (names.length === 0) return []
  const resources = listRefreshResourcesByNames(database(), AuthorResource, names)
  const byName = new Map(resources.map(resource => [resource.metadata.name, resource]))
  const overlay = overlayEntries('authors', names)
  return names
    .map(name => byName.get(name))
    .filter((resource): resource is Resource => !!resource)
    .map(resource => applyEntry(resource, overlay[resource.metadata.name]))
}

export async function getAuthor(name: string) {
  const resource = getRefreshResource(database(), AuthorResource, name)
  if (!resource) return null
  return applyEntry(resource, overlayEntries('authors', [name])[name])
}

export function listWindowResources(sourceFilter?: string): Resource[] {
  return selectWindows(sourceFilter).map(rowToWindowResource)
}

function rowToWindowResource(row: WindowRow): Resource {
  const labels = safeJson<Record<string, string>>(row.labels_json, {})
  const annotations = safeJson<Record<string, string>>(row.annotations, {})
  const creationTimestamp = annotations[CREATION_TIMESTAMP_ANNOTATION]
  if (creationTimestamp) delete annotations[CREATION_TIMESTAMP_ANNOTATION]
  return {
    apiVersion: 'radar/v1',
    kind: RefreshWindowResource.kind,
    metadata: {
      name: row.name,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(creationTimestamp ? { creationTimestamp } : {}),
    },
    spec: safeJson<Record<string, unknown>>(row.spec_json, {}),
    status: statusFromRow(row.status_spec_json),
  }
}

function statusFromRow(statusJson: string | null): Record<string, unknown> {
  if (!statusJson) return {}
  const envelope = safeJson<Record<string, unknown>>(statusJson, {})
  const value = envelope.value
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const CREATION_TIMESTAMP_ANNOTATION = 'refresh.internal/creationTimestamp'

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function getWindowResource(name: string): Resource | null {
  return getRefreshResource(database(), RefreshWindowResource, name)
}

/** Account.status 由 auth/login 写入（落库，不再维护内存 Map）。 */
export async function setAccountStatus(name: string, status: Record<string, unknown>): Promise<void> {
  const current = getRefreshResource(database(), AccountStatusResource, name)
  await putStoredResource({
    apiVersion: 'radar/v1',
    kind: AccountStatusResource.kind,
    metadata: { name, labels: { ...(current?.metadata.labels ?? {}) } },
    spec: {},
    status: { ...(current?.status as Record<string, unknown>), ...status },
  } as Resource)
}

export function accountResources(): Resource[] {
  const statuses = new Map(
    listRefreshResources(database(), AccountStatusResource).map(resource => [
      resource.metadata.name,
      resource.status as Record<string, unknown>,
    ]),
  )
  return ACCOUNTS.map(account => ({
    apiVersion: 'radar/v1' as const,
    kind: 'Account',
    metadata: { name: account.name, labels: { platform: account.platform } },
    spec: { platform: account.platform, displayName: account.displayName, profileDir: account.profileDir ?? null },
    status: statuses.get(account.name) ?? { auth: 'unknown', lastChecked: null },
  }))
}

// ---------- 维护：用当前 normalizer 重算历史 message ----------

export interface RebuildReport {
  dryRun: boolean
  windows: number
  updated: number
  missing: number
  durationMs: number
}

/**
 * 只更新已存在的 message（不新建、不删除），保留 created_at / lastSeenWindow / overlay。
 * 用于「改了 normalizer，想让老数据跟上」——读路径直查之后重启不再自动重放。
 */
export async function rebuildMessages(opts: { dryRun?: boolean } = {}): Promise<RebuildReport> {
  const dryRun = opts.dryRun ?? true
  const startedAt = Date.now()
  const db = database()
  const { listWindowNames, readWindowFile } = await import('./store')
  let updated = 0
  let missing = 0
  const names = await listWindowNames()

  for (const windowName of names) {
    let win
    try {
      win = await readWindowFile(windowName)
    } catch {
      continue
    }
    const source = getSource(String((win.spec as Record<string, unknown>).source))
    const platform = source?.platform ?? String(windowName.split('-')[0])
    const batch: Resource[] = []
    for (const raw of expandRawItems(platform, win.rawItems ?? [])) {
      const normalized = normalizeItem(platform, raw)
      if (!normalized) continue
      const existing = getRefreshResource(db, MessageResource, normalized.message.name) as Resource | null
      if (!existing) {
        missing++
        continue
      }
      for (const m of normalized.message.spec.media) {
        m.url = m.url ?? localMediaUrl(m.originUrl)
        attachMediaPresentation(m)
      }
      localizeAvatar(normalized.message.spec.author)
      existing.spec = normalized.message.spec as unknown as Record<string, unknown>
      batch.push(existing)
      updated++
    }
    if (!dryRun) {
      for (const resource of batch) await putStoredResource(resource)
    }
  }

  return { dryRun, windows: names.length, updated, missing, durationMs: Date.now() - startedAt }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T
}

/** 供维护脚本复用：按定义直接读资源（保留导出以免 scripts 里 import 内部模块）。 */
export function refreshResources(definition: ResourceDefinition): Resource[] {
  return listRefreshResources(database(), definition)
}
