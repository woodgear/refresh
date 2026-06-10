// 资源索引：启动时扫描 window 档案，合并去重出 Message/Author 内存索引；
// RefreshWindow 完成后通过 ingestWindow 增量并入。overlay 在读取时合并（PATCH 即时生效，无需重建）。

import { ACCOUNTS, getSource } from './config'
import { normalizeItem, expandRawItems } from './normalize'
import { localMediaUrl } from './media'
import { rlog } from './logger'
import {
  applyOverlay,
  listWindowNames,
  readOverlay,
  readWindowFile,
  type OverlayKind,
  type Resource,
  type WindowFile,
} from './store'

export interface MessageStatus extends Record<string, unknown> {
  hydrated: boolean
}

export interface AuthorStatus extends Record<string, unknown> {
  messageCount: number
  lastSeenAt: string | null
}

const messages = new Map<string, Resource<Record<string, unknown>, MessageStatus>>()
const authors = new Map<string, Resource<Record<string, unknown>, AuthorStatus>>()
/** window 资源（不含 rawItems，列表用） */
const windows = new Map<string, Resource>()

/** 互动数据字段：重复出现时允许更新（docs/design.md §2 可变性策略） */
function mergeStats(oldSpec: Record<string, unknown>, newSpec: Record<string, unknown>): void {
  if (newSpec.stats) oldSpec.stats = newSpec.stats
}

export function ingestWindow(win: WindowFile): { newCount: number; dupCount: number } {
  const source = getSource(String((win.spec as Record<string, unknown>).source))
  const windowName = win.metadata.name
  const fetchedAt = win.metadata.creationTimestamp ?? null
  const platform = source?.platform ?? String(windowName.split('-')[0])
  let newCount = 0
  let dupCount = 0

  for (const raw of expandRawItems(platform, win.rawItems ?? [])) {
    const normalized = normalizeItem(platform, raw)
    if (!normalized) continue

    const { message, author } = normalized
    const existing = messages.get(message.name)
    if (existing) {
      dupCount++
      mergeStats(existing.spec, message.spec as unknown as Record<string, unknown>)
      existing.metadata.annotations!['radar/lastSeenWindow'] = windowName
      // 同一条内容可能被多个源推到（如关注的人的推文同时出现在推荐流）：归属是集合
      if (source) {
        const cur = (existing.metadata.annotations!['radar/sources'] ?? existing.metadata.labels?.source ?? '')
          .split(',')
          .filter(Boolean)
        if (!cur.includes(source.name)) {
          cur.push(source.name)
          existing.metadata.annotations!['radar/sources'] = cur.join(',')
        }
      }
    } else {
      newCount++
      // 媒体/头像回填：已本地化的换成 /api/v1/media/<hash>，否则保留外链
      for (const m of message.spec.media) m.url = m.url ?? localMediaUrl(m.originUrl)
      // 不同尺寸参数的同一张图本地化后哈希相同，按最终地址去重
      const seenMedia = new Set<string>()
      message.spec.media = message.spec.media.filter(m => {
        const key = m.url ?? m.originUrl
        if (seenMedia.has(key)) return false
        seenMedia.add(key)
        return true
      })
      if (message.spec.author?.avatar) {
        message.spec.author.avatar = localMediaUrl(message.spec.author.avatar) ?? message.spec.author.avatar
      }
      // 正文 HTML 里的图也换成本地化地址（RSS/UI 都不再依赖图床防盗链）
      if (message.spec.content) {
        message.spec.content = message.spec.content.replace(/(<img[^>]+src=")([^"]+)(")/g, (whole, pre, src, post) => {
          const local = localMediaUrl(src)
          return local ? `${pre}${local}${post}` : whole
        })
      }
      messages.set(message.name, {
        apiVersion: 'radar/v1',
        kind: 'Message',
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
      })
    }

    if (author) {
      const existingAuthor = authors.get(author.name)
      if (existingAuthor) {
        existingAuthor.status.messageCount += existing ? 0 : 1
        existingAuthor.status.lastSeenAt = fetchedAt
        // 快照字段允许跟进最新（作者改名/换头像）
        Object.assign(existingAuthor.spec, stripUndefined(author.spec))
      } else {
        const spec = stripUndefined(author.spec)
        if (spec.avatar) spec.avatar = localMediaUrl(spec.avatar) ?? spec.avatar
        authors.set(author.name, {
          apiVersion: 'radar/v1',
          kind: 'Author',
          metadata: { name: author.name, labels: { platform }, annotations: {} },
          spec,
          status: { messageCount: 1, lastSeenAt: fetchedAt },
        })
      }
    }
  }

  registerWindowResource(win, { newCount, dupCount })
  return { newCount, dupCount }
}

export function registerWindowResource(win: WindowFile, counts?: { newCount: number; dupCount: number }): void {
  const { rawItems: _rawItems, ...resource } = win
  windows.set(win.metadata.name, resource as Resource)
  if (counts) {
    const status = resource.status as Record<string, unknown>
    const stats = (status.stats ?? {}) as Record<string, unknown>
    status.stats = { ...stats, new: counts.newCount, duplicate: counts.dupCount, fetched: counts.newCount + counts.dupCount }
  }
}

export async function buildIndex(): Promise<void> {
  messages.clear()
  authors.clear()
  windows.clear()
  for (const name of await listWindowNames()) {
    try {
      ingestWindow(await readWindowFile(name))
    } catch (err) {
      rlog('index', `skip corrupt window ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  rlog('index', `built: ${messages.size} messages, ${authors.size} authors, ${windows.size} windows`)
}

// ---------- 查询 ----------

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

function matchLabels(resource: Resource, selector: Record<string, string> | null): boolean {
  if (!selector) return true
  const labels = resource.metadata.labels ?? {}
  return Object.entries(selector).every(([k, v]) => labels[k] === v)
}

async function withOverlay<S, T extends Record<string, unknown>>(
  kind: OverlayKind,
  items: Resource<S, T>[],
): Promise<Resource<S, T>[]> {
  const overlay = await readOverlay(kind)
  return items.map(item => applyOverlay(item, overlay[item.metadata.name]))
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

export async function listMessages(opts: ListMessagesOpts) {
  if (opts.names) {
    const picked = opts.names.map(n => messages.get(n)).filter((m): m is NonNullable<typeof m> => !!m)
    return withOverlay('messages', opts.limit ? picked.slice(0, opts.limit) : picked)
  }
  const selector = parseSelector(opts.labelSelector)
  // source 是多值归属：selector 里的 source=X 按 radar/sources 集合匹配（含被其他源先抓到的同一条内容）
  let wantSource: string | null = null
  if (selector && 'source' in selector) {
    wantSource = selector.source
    delete selector.source
  }
  let authorRefs: Set<string> | null = null
  if (opts.authorSelector) {
    const matched = await listAuthors({ labelSelector: opts.authorSelector })
    authorRefs = new Set(matched.map(a => a.metadata.name))
  }

  let result = [...messages.values()].filter(m => matchLabels(m, selector))
  if (wantSource) {
    result = result.filter(m => {
      const sources = m.metadata.annotations?.['radar/sources'] ?? m.metadata.labels?.source ?? ''
      return sources.split(',').includes(wantSource)
    })
  }
  if (authorRefs) {
    result = result.filter(m => {
      const ref = (m.metadata.labels ?? {}).author
      return ref !== undefined && authorRefs.has(ref)
    })
  }
  // 排序/未读过滤需要 read 状态（在 overlay 里），先合并再处理
  let merged = await withOverlay('messages', result)
  const isRead = (m: (typeof merged)[number]) => !!(m.status as Record<string, unknown>).read
  if (opts.unreadOnly) merged = merged.filter(m => !isRead(m))
  const t = (m: (typeof merged)[number]) => m.metadata.creationTimestamp ?? ''
  merged.sort(
    opts.sort === 'unread-first'
      ? (a, b) => Number(isRead(a)) - Number(isRead(b)) || t(b).localeCompare(t(a))
      : (a, b) => t(b).localeCompare(t(a)),
  )
  if (opts.limit && opts.limit > 0) merged = merged.slice(0, opts.limit)
  return merged
}

/** 各源未读数（按多源归属计；total 为去重后的全局未读数） */
export async function unreadCounts(): Promise<{ total: number; sources: Record<string, number> }> {
  const overlay = await readOverlay('messages')
  const sources: Record<string, number> = {}
  let total = 0
  for (const m of messages.values()) {
    if ((overlay[m.metadata.name]?.status as Record<string, unknown> | undefined)?.read) continue
    total++
    const list = (m.metadata.annotations?.['radar/sources'] ?? m.metadata.labels?.source ?? '').split(',').filter(Boolean)
    for (const s of list) sources[s] = (sources[s] ?? 0) + 1
  }
  return { total, sources }
}

export async function getMessage(name: string) {
  const m = messages.get(name)
  if (!m) return null
  const [merged] = await withOverlay('messages', [m])
  return merged
}

export async function listAuthors(opts: { labelSelector?: string; limit?: number }) {
  // overlay 的 label（如 category）参与 selector 匹配，所以先合并再过滤
  const merged = await withOverlay('authors', [...authors.values()])
  const selector = parseSelector(opts.labelSelector)
  let result = merged.filter(a => matchLabels(a, selector))
  result.sort((a, b) => b.status.messageCount - a.status.messageCount)
  if (opts.limit && opts.limit > 0) result = result.slice(0, opts.limit)
  return result
}

export async function getAuthor(name: string) {
  const a = authors.get(name)
  if (!a) return null
  const [merged] = await withOverlay('authors', [a])
  return merged
}

export function listWindowResources(sourceFilter?: string): Resource[] {
  let result = [...windows.values()]
  if (sourceFilter) {
    result = result.filter(w => (w.spec as Record<string, unknown>).source === sourceFilter)
  }
  return result.sort((a, b) => b.metadata.name.localeCompare(a.metadata.name))
}

export function getWindowResource(name: string): Resource | null {
  return windows.get(name) ?? null
}

export function accountResources(): Resource[] {
  return ACCOUNTS.map(a => ({
    apiVersion: 'radar/v1' as const,
    kind: 'Account',
    metadata: { name: a.name, labels: { platform: a.platform } },
    spec: { platform: a.platform, displayName: a.displayName, profileDir: a.profileDir ?? null },
    status: accountStatus.get(a.name) ?? { auth: 'unknown', lastChecked: null },
  }))
}

/** Account.status 由 auth 模块（M3）写入 */
export const accountStatus = new Map<string, Record<string, unknown>>()

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}
